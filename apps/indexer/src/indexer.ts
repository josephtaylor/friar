// ChainIndexer: single "main" Durable Object running the poll loop.
// Cursor lives in DO storage; all domain data goes to D1 (shared with the API worker).
//
// NOTE ON ARITHMETIC: token amounts are uint128/int256-scale — far beyond SQLite's
// 64-bit INTEGER and JS Number. All accumulation is read-modify-write with BigInt in
// JS; columns store decimal strings. Never do `CAST(col AS INTEGER) + ?` on amounts.
//
// NOTE ON PAGE STATE: one tx can emit several events for one position (collect emits
// FeesCollected + PerfFeeCharged; close emits PositionDecreased + PerfFeeCharged). Totals accumulate
// in per-page memory and flush as ONE update per position, or later events would
// clobber earlier ones within the same batch.
import { DurableObject } from "cloudflare:workers";
import { getAddress, parseEventLogs, type PublicClient } from "viem";
import { rpcClient, probeEndpoints, withRpcRetry } from "./rpc.js";
import { friarPositionManagerAbi, managerAddresses, poolId as computePoolId, type PoolKey } from "@friar/chain";
import { poolManagerSwapEvent, v3SwapEvent, jsonWithBigints, type DecodedSwap } from "./decode.js";
import { foldCandles, type CandleAgg } from "./candles.js";
import { runSnapshots } from "./snapshots.js";
import { markPosition } from "@friar/core";
import { getSlot0 } from "@friar/chain";
import type { Env } from "./worker.js";

// Each caught-up poll costs a getBlockNumber + 3 getLogs + a block header per distinct
// block with activity — call it ~235 compute units, dominated by the getLogs at 75 CU each.
// That makes the poll interval a BILLING dial, not just a load dial: on Alchemy PAYG at
// $0.45/M CU, 8s polling is ~81M CU/mo (~$36) while 60s is ~11M (~$5). Nothing downstream
// is finer-grained than a 5-minute candle, so the slower rate costs no visible freshness.
// (History: 2s originally; 8s on 2026-07-25 when the free sequencer endpoint started
// answering "Too Many Requests"; 60s once Alchemy PAYG became the primary endpoint.)
// The one moment a slow poll would be felt — "did my open land?" — is covered by the web
// app's eager ingest-by-tx-hash, which never waits for the poll.
const POLL_MS = 60_000;
const MAX_RANGE = 2_000n; // getLogs page size — bounds backfill iterations
const CONFIRMATIONS = 5n;

interface ManagerEvent {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: `0x${string}`;
  /** Which manager deployment emitted it — logs now come from several addresses. */
  address: `0x${string}`;
}

interface Totals {
  flow0: bigint;
  flow1: bigint;
  fees0: bigint;
  fees1: bigint;
  perf0: bigint;
  perf1: bigint;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Per-poll accumulation so multiple events touching one position merge correctly. */
class PageState {
  totals = new Map<number, Totals>();
  bins = new Map<number, Map<number, bigint>>();
  constructor(private db: D1Database) {}

  async totalsFor(positionId: number): Promise<Totals | null> {
    let t = this.totals.get(positionId) ?? null;
    if (!t) {
      const row = await this.db
        .prepare("SELECT flow0, flow1, fees0, fees1, perf0, perf1 FROM positions WHERE position_id = ?")
        .bind(positionId)
        .first<Record<keyof Totals, string>>();
      if (!row) return null; // position opened before START_BLOCK — raw event still recorded
      t = {
        flow0: BigInt(row.flow0),
        flow1: BigInt(row.flow1),
        fees0: BigInt(row.fees0),
        fees1: BigInt(row.fees1),
        perf0: BigInt(row.perf0),
        perf1: BigInt(row.perf1),
      };
      this.totals.set(positionId, t);
    }
    return t;
  }

  seedOpened(positionId: number, binLiquidity: bigint[]): void {
    this.totals.set(positionId, { flow0: 0n, flow1: 0n, fees0: 0n, fees1: 0n, perf0: 0n, perf1: 0n });
    this.bins.set(positionId, new Map(binLiquidity.map((l, i) => [i, l])));
  }

  async binsFor(positionId: number): Promise<Map<number, bigint>> {
    let m = this.bins.get(positionId);
    if (!m) {
      const rows = await this.db
        .prepare("SELECT bin_index, liquidity FROM position_bins WHERE position_id = ?")
        .bind(positionId)
        .all<{ bin_index: number; liquidity: string }>();
      m = new Map(rows.results.map((r) => [r.bin_index, BigInt(r.liquidity)]));
      this.bins.set(positionId, m);
    }
    return m;
  }

  flush(stmts: D1PreparedStatement[]): void {
    for (const [id, t] of this.totals) {
      stmts.push(
        this.db
          .prepare(
            "UPDATE positions SET flow0 = ?, flow1 = ?, fees0 = ?, fees1 = ?, perf0 = ?, perf1 = ? WHERE position_id = ?",
          )
          .bind(
            t.flow0.toString(),
            t.flow1.toString(),
            t.fees0.toString(),
            t.fees1.toString(),
            t.perf0.toString(),
            t.perf1.toString(),
            id,
          ),
      );
    }
    for (const [id, bins] of this.bins) {
      for (const [i, liq] of bins) {
        stmts.push(
          this.db
            .prepare("UPDATE position_bins SET liquidity = ? WHERE position_id = ? AND bin_index = ?")
            .bind(liq.toString(), id, i),
        );
      }
    }
  }
}

export class ChainIndexer extends DurableObject<Env> {
  private client: PublicClient;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // NOTE: no JSON-RPC batching — the Robinhood RPC rejects batch arrays.
    this.client = rpcClient(env);
  }

  async start(fromBlock?: number): Promise<{ cursor: number }> {
    let cursor = await this.ctx.storage.get<number>("cursor");
    if (cursor === undefined || fromBlock !== undefined) {
      cursor = fromBlock ?? Number(this.env.START_BLOCK);
      await this.ctx.storage.put("cursor", cursor);
    }
    await this.ctx.storage.setAlarm(Date.now() + 100);
    return { cursor };
  }

  async stop(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
  }

  async status(): Promise<{ cursor: number | undefined; alarmAt: number | null; lastError: string | null; recentErrors: string[] }> {
    return {
      cursor: await this.ctx.storage.get<number>("cursor"),
      alarmAt: await this.ctx.storage.getAlarm(),
      lastError: (await this.ctx.storage.get<string>("lastError")) ?? null,
      recentErrors: (await this.ctx.storage.get<string[]>("recentErrors")) ?? [],
    };
  }

  /** Ring of the last 20 — lastError alone gets overwritten by the next RPC flap, losing
   * exactly the error a report was about. Returns the formatted line. */
  private async recordError(err: unknown, tag: string): Promise<string> {
    const line = `${new Date().toISOString()} [${tag}] ${String(err)}`;
    console.error(`indexer: ${line}`); // → Workers Logs (observability is on)
    const ring = (await this.ctx.storage.get<string[]>("recentErrors")) ?? [];
    ring.push(line);
    await this.ctx.storage.put("recentErrors", ring.slice(-20));
    return line;
  }

  async alarm(): Promise<void> {
    let delay = POLL_MS;
    try {
      const caughtUp = await this.poll();
      if (!caughtUp) delay = 50; // backfilling: keep paging without waiting
      await this.ctx.storage.delete("lastError");
      await this.ctx.storage.delete("rpcFailures");
    } catch (err) {
      const line = await this.recordError(err, "alarm");
      await this.ctx.storage.put("lastError", line);
      // Which endpoint is actually broken? fallback() only reports the last one's error,
      // so probe them individually — a bad key, a rate limit and a typo'd URL are three
      // different fixes and look identical from the outside. Hosts only, never the key.
      // Probe on EVERY poll failure. Gating this on a counter meant it never ran after a
      // deploy (the counter persists in DO storage), which is exactly when you most need
      // it. Three eth_chainId calls per 5-minute failure is free.
      await this.recordError(await probeEndpoints(this.env), "rpc-probe");
      // A FIXED retry against a rate-limited RPC never recovers — it IS the load keeping
      // the limit tripped (2026-07-25: "Too Many Requests" every 11s for an hour). Back
      // off exponentially, capped at 5 min, and reset the instant a poll succeeds.
      const n = ((await this.ctx.storage.get<number>("rpcFailures")) ?? 0) + 1;
      await this.ctx.storage.put("rpcFailures", n);
      delay = Math.min(10_000 * 2 ** (n - 1), 300_000);
    }

    // Marking is INDEPENDENT of indexing: it reads chain state, not logs. It used to sit
    // inside poll's success path (and behind caughtUp), so one rate-limited getLogs froze
    // every position's unclaimed fees at their open-time value while the fees accrued on
    // chain — the "zero fills" report of 2026-07-25. The external cron is a no-op in
    // local dev, so the loop has to own this. Failures go to the ring only.
    try {
      const lastSnap = (await this.ctx.storage.get<number>("lastSnapshotMs")) ?? 0;
      if (Date.now() - lastSnap > 300_000) {
        await runSnapshots(this.env);
        await this.ctx.storage.put("lastSnapshotMs", Date.now());
      }
    } catch (err) {
      await this.recordError(err, "snapshots");
    }
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  /** One page of indexing. Returns true when caught up to (head - confirmations). */
  private async poll(): Promise<boolean> {
    const cursor = BigInt((await this.ctx.storage.get<number>("cursor")) ?? Number(this.env.START_BLOCK));
    const head = (await this.client.getBlockNumber()) - CONFIRMATIONS;
    if (head <= cursor) return true;
    const from = cursor + 1n;
    const to = head - from > MAX_RANGE ? from + MAX_RANGE : head;

    const managerLogs = await withRpcRetry(() =>
      this.client.getLogs({
        // every deployed manager, so a retired one's exits keep being indexed
        address: managerAddresses(),
        fromBlock: from,
        toBlock: to,
      }),
    );
    const events = parseEventLogs({ abi: friarPositionManagerAbi, logs: managerLogs }) as unknown as ManagerEvent[];

    // Watch list = pools already in D1 ∪ pools opened in THIS page, so a pool's very
    // first swaps (openNew + immediate flow) land in the same page's candles.
    const watched = await this.watchedPools(events);
    const swapLogs = watched.length
      ? await withRpcRetry(() =>
          this.client.getLogs({
            address: this.env.POOL_MANAGER as `0x${string}`,
            event: poolManagerSwapEvent,
            args: { id: watched },
            fromBlock: from,
            toBlock: to,
          }),
        )
      : [];

    // Incumbent v3 venues: token price history before a Friar pool exists (creation
    // charts) and the flow-share baseline after. One getLogs, address array.
    const v3Watched = await this.watchedV3Pools();
    const v3Logs = v3Watched.length
      ? await withRpcRetry(() =>
          this.client.getLogs({
            address: v3Watched,
            event: v3SwapEvent,
            fromBlock: from,
            toBlock: to,
          }),
        )
      : [];

    const tsByBlock = await this.blockTimestamps([
      ...events.map((e) => e.blockNumber),
      ...swapLogs.map((l) => l.blockNumber),
      ...v3Logs.map((l) => l.blockNumber),
    ]);

    const stmts: D1PreparedStatement[] = [];
    const page = new PageState(this.env.DB);
    for (const e of events) {
      await this.applyManagerEvent(stmts, page, e, tsByBlock.get(e.blockNumber) ?? 0);
    }
    page.flush(stmts);

    const swaps: DecodedSwap[] = [
      ...swapLogs.map((l) => ({
        poolId: l.args.id!,
        block: l.blockNumber,
        ts: tsByBlock.get(l.blockNumber) ?? 0,
        amount0: l.args.amount0!,
        amount1: l.args.amount1!,
        sqrtPriceX96: l.args.sqrtPriceX96!,
        tick: l.args.tick!,
        fee: Number(l.args.fee!),
      })),
      ...v3Logs.map((l) => ({
        poolId: l.address.toLowerCase() as `0x${string}`,
        block: l.blockNumber,
        ts: tsByBlock.get(l.blockNumber) ?? 0,
        amount0: l.args.amount0!,
        amount1: l.args.amount1!,
        sqrtPriceX96: l.args.sqrtPriceX96!,
        tick: l.args.tick!,
        fee: null, // v3 static tier — known from the pool row, not per-swap
      })),
    ];
    for (const c of foldCandles(swaps)) {
      stmts.push(await this.mergedCandleUpsert(c));
    }

    if (stmts.length) await this.env.DB.batch(stmts);
    await this.ctx.storage.put("cursor", Number(to));
    // a newborn position must never sit unmarked: value-at-zero reads as pure loss
    if (events.some((e) => e.eventName === "PositionOpened")) {
      await runSnapshots(this.env);
      await this.ctx.storage.put("lastSnapshotMs", Date.now());
    }
    return to === head;
  }

  // fee_{sum,n,max} were retrofitted onto live candles tables (same pattern as tokens
  // vol1/vol6): ALTER once per DO lifetime, swallow "duplicate column" on every rerun.
  private feeColumnsReady = false;
  private async ensureFeeColumns(): Promise<void> {
    if (this.feeColumnsReady) return;
    for (const col of ["fee_sum INTEGER", "fee_n INTEGER", "fee_max INTEGER"]) {
      await this.env.DB.prepare(`ALTER TABLE candles ADD COLUMN ${col}`).run().catch(() => {});
    }
    this.feeColumnsReady = true;
  }

  /** Merge a folded candle with any existing row in JS BigInt (exact), then replace. */
  private async mergedCandleUpsert(c: CandleAgg): Promise<D1PreparedStatement> {
    await this.ensureFeeColumns();
    const existing = await this.env.DB.prepare(
      "SELECT open, high, low, vol0, vol1, swaps, fee_sum, fee_n, fee_max FROM candles WHERE pool_id = ? AND ts = ?",
    )
      .bind(c.poolId, c.ts)
      .first<{
        open: string;
        high: string;
        low: string;
        vol0: string;
        vol1: string;
        swaps: number;
        fee_sum: number | null;
        fee_n: number | null;
        fee_max: number | null;
      }>();

    let { open, high, low, vol0, vol1, swaps, feeSum, feeN, feeMax } = c;
    if (existing) {
      open = BigInt(existing.open); // stored row is chronologically earlier
      if (BigInt(existing.high) > high) high = BigInt(existing.high);
      if (BigInt(existing.low) < low) low = BigInt(existing.low);
      vol0 += BigInt(existing.vol0);
      vol1 += BigInt(existing.vol1);
      swaps += existing.swaps;
      // NULL fee columns (pre-migration row / v3 pool) contribute nothing — feeN keeps
      // the average honest across the boundary
      feeSum += existing.fee_sum ?? 0;
      feeN += existing.fee_n ?? 0;
      if (existing.fee_max != null && (feeMax === null || existing.fee_max > feeMax)) feeMax = existing.fee_max;
    }
    return this.env.DB.prepare(
      "INSERT OR REPLACE INTO candles (pool_id, ts, open, high, low, close, vol0, vol1, swaps, fee_sum, fee_n, fee_max) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      c.poolId,
      c.ts,
      open.toString(),
      high.toString(),
      low.toString(),
      c.close.toString(),
      vol0.toString(),
      vol1.toString(),
      swaps,
      feeN > 0 ? feeSum : null,
      feeN > 0 ? feeN : null,
      feeMax,
    );
  }

  private async applyManagerEvent(
    stmts: D1PreparedStatement[],
    page: PageState,
    e: ManagerEvent,
    ts: number,
  ): Promise<void> {
    const a = e.args;
    const positionId = a.positionId !== undefined ? Number(a.positionId) : null;

    // Replays are routine — eager ingest and the cursor crawl both visit the same tx,
    // and backfills/restarts re-scan ranges. The events PK makes the LOG idempotent,
    // but everything below mutates cumulative state (flow/fees/perf totals, bin
    // liquidity) and double-applies silently: position 13 shipped 2× fees and negative
    // bin liquidity this way. The event row is the applied-marker — already there
    // means fully applied, so skip the whole event.
    const applied = await this.env.DB.prepare("SELECT 1 AS x FROM events WHERE block = ? AND log_index = ?")
      .bind(Number(e.blockNumber), e.logIndex)
      .first();
    if (applied) return;

    stmts.push(
      this.env.DB.prepare(
        "INSERT OR IGNORE INTO events (block, log_index, tx_hash, ts, name, position_id, pool_id, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        Number(e.blockNumber),
        e.logIndex,
        e.transactionHash,
        ts,
        e.eventName,
        positionId,
        (a.poolId as string) ?? null,
        jsonWithBigints(a),
      ),
    );

    switch (e.eventName) {
      case "PositionOpened": {
        const key = a.key as PoolKey;
        const pid = computePoolId(key);
        stmts.push(
          this.env.DB.prepare(
            "INSERT OR IGNORE INTO pools (pool_id, currency0, currency1, fee, tick_spacing, hooks) VALUES (?, ?, ?, ?, ?, ?)",
          ).bind(pid, key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks),
        );
        stmts.push(
          this.env.DB.prepare(
            "INSERT OR REPLACE INTO positions (position_id, manager, owner, pool_id, opened_block, opened_ts, open_delta0, open_delta1) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          ).bind(
            positionId,
            getAddress(e.address),
            a.owner as string,
            pid,
            Number(e.blockNumber),
            ts,
            String(a.delta0),
            String(a.delta1),
          ),
        );
        const bins = a.bins as Array<{ tickLower: number; tickUpper: number; liquidity: bigint }>;
        bins.forEach((b, i) => {
          stmts.push(
            this.env.DB.prepare(
              "INSERT OR REPLACE INTO position_bins (position_id, bin_index, tick_lower, tick_upper, liquidity) VALUES (?, ?, ?, ?, ?)",
            ).bind(positionId, i, b.tickLower, b.tickUpper, b.liquidity.toString()),
          );
        });
        page.seedOpened(positionId!, bins.map((b) => b.liquidity));
        break;
      }
      case "PositionIncreased":
      case "PositionDecreased": {
        const t = await page.totalsFor(positionId!);
        if (!t) break;
        const sign = e.eventName === "PositionIncreased" ? 1n : -1n;
        const deltas = a.liquidityDeltas as bigint[];
        if (deltas.some((d) => d !== 0n)) {
          const bins = await page.binsFor(positionId!);
          deltas.forEach((d, i) => {
            if (d !== 0n) bins.set(i, (bins.get(i) ?? 0n) + sign * d);
          });
        }
        t.flow0 += BigInt(String(a.delta0));
        t.flow1 += BigInt(String(a.delta1));
        t.fees0 += BigInt(String(a.fees0));
        t.fees1 += BigInt(String(a.fees1));
        if (e.eventName === "PositionDecreased" && a.closed === true) {
          stmts.push(
            this.env.DB.prepare("UPDATE positions SET closed_block = ?, closed_ts = ? WHERE position_id = ?").bind(
              Number(e.blockNumber),
              ts,
              positionId,
            ),
          );
        }
        break;
      }
      case "FeesCollected": {
        const t = await page.totalsFor(positionId!);
        if (!t) break;
        t.flow0 += BigInt(String(a.delta0));
        t.flow1 += BigInt(String(a.delta1));
        t.fees0 += BigInt(String(a.fees0));
        t.fees1 += BigInt(String(a.fees1));
        break;
      }
      case "PerfFeeCharged": {
        const t = await page.totalsFor(positionId!);
        if (!t) break;
        t.perf0 += BigInt(String(a.perf0));
        t.perf1 += BigInt(String(a.perf1));
        break;
      }
    }
  }

  private async watchedPools(newEvents: ManagerEvent[]): Promise<`0x${string}`[]> {
    const rows = await this.env.DB.prepare("SELECT pool_id FROM pools WHERE watched = 1").all<{ pool_id: string }>();
    const ids = new Set(rows.results.map((r) => r.pool_id as `0x${string}`));
    for (const e of newEvents) {
      if (e.eventName === "PositionOpened") ids.add(computePoolId(e.args.key as PoolKey));
    }
    return [...ids];
  }

  /**
   * Eager ingest: apply a just-confirmed tx's manager events NOW instead of waiting
   * for the cursor to crawl there. Idempotent vs the cursor pass (events PK dedupes).
   * A fresh position's fees are zero by definition, so its first snapshot is pure
   * math + one slot0 read — instant, no per-bin fee sweep.
   */
  async ingestTx(hash: `0x${string}`): Promise<{ events: number; positions: number[] }> {
    const receipt = await this.rpc(() => this.client.getTransactionReceipt({ hash }));
    const known = new Set(managerAddresses().map((a) => a.toLowerCase()));
    const managerLogs = receipt.logs.filter((l) => known.has(l.address.toLowerCase()));
    const events = parseEventLogs({ abi: friarPositionManagerAbi, logs: managerLogs }) as unknown as ManagerEvent[];
    if (!events.length) return { events: 0, positions: [] };
    const block = await this.rpc(() => this.client.getBlock({ blockNumber: receipt.blockNumber }));
    const ts = Number(block.timestamp);

    const stmts: D1PreparedStatement[] = [];
    const page = new PageState(this.env.DB);
    for (const e of events) {
      await this.applyManagerEvent(stmts, page, e, ts);
    }
    page.flush(stmts);

    // instant zero-fee snapshot for any position opened in this tx
    const openedPositions: number[] = [];
    for (const e of events) {
      if (e.eventName !== "PositionOpened") continue;
      const positionId = Number(e.args.positionId);
      openedPositions.push(positionId);
      const poolIdHex = e.args.poolId as `0x${string}`;
      const bins = (e.args.bins as Array<{ tickLower: number; tickUpper: number; liquidity: bigint }>).map((b) => ({
        tickLower: b.tickLower,
        tickUpper: b.tickUpper,
        liquidity: b.liquidity,
      }));
      const slot0 = await this.rpc(() => getSlot0(this.client, poolIdHex));
      const mark = markPosition(bins, slot0.sqrtPriceX96);
      stmts.push(
        this.env.DB.prepare(
          "INSERT OR REPLACE INTO snapshots (position_id, ts, sqrt_price, market_sqrt_price, amount0, amount1, fees0, fees1) VALUES (?, ?, ?, NULL, ?, ?, '0', '0')",
        ).bind(positionId, ts, slot0.sqrtPriceX96.toString(), mark.amount0.toString(), mark.amount1.toString()),
      );
    }

    if (stmts.length) await this.env.DB.batch(stmts);
    return { events: events.length, positions: openedPositions };
  }

  /** The public Robinhood RPC rate-limits per minute-window: retry with a wait. */
  private async rpc<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt >= 5 || !/rate limit/i.test(String(err))) throw err;
        await sleep(15_000);
      }
    }
  }

  /**
   * One-shot historical candle fill for a single pool — the "lazy promote" that turns
   * a never-seen token into a native chart. `target` is a v4 PoolId (66 chars) or a
   * v3 pool address (42 chars). Pages capped so a runaway range can't hang the DO;
   * production-scale backfills should chunk via repeated calls (each call resumes
   * nothing — it recomputes candle merges idempotently).
   *
   * Timestamps are interpolated from page-edge anchors (2 getBlock per page) — exact
   * per-block fetches would melt the rate-limited public RPC, and a ±minute smear is
   * irrelevant for chart candles.
   */
  async backfill(target: `0x${string}`, hours: number): Promise<{
    fromBlock: number;
    toBlock: number;
    pages: number;
    swaps: number;
    candles: number;
  }> {
    const MAX_PAGES = 500;
    const isV4 = target.length === 66;
    const head = await this.rpc(() => this.client.getBlockNumber());
    const blockTs = async (b: bigint) =>
      Number((await this.rpc(() => this.client.getBlock({ blockNumber: b }))).timestamp);
    const headTs = await blockTs(head);
    const fromBlock = await this.findBlockByTimestamp(headTs - hours * 3600, head);

    let from = fromBlock;
    let fromTs = await blockTs(fromBlock);
    let pages = 0;
    let swapCount = 0;
    let candleCount = 0;
    while (from <= head && pages < MAX_PAGES) {
      const to = head - from > MAX_RANGE ? from + MAX_RANGE : head;
      const toTs = to === head ? headTs : await blockTs(to);
      const logs = isV4
        ? await this.rpc(() =>
            this.client.getLogs({
              address: this.env.POOL_MANAGER as `0x${string}`,
              event: poolManagerSwapEvent,
              args: { id: [target] },
              fromBlock: from,
              toBlock: to,
            }),
          )
        : await this.rpc(() => this.client.getLogs({ address: target, event: v3SwapEvent, fromBlock: from, toBlock: to }));

      if (logs.length) {
        const span = Number(to - from) || 1;
        const interpTs = (b: bigint) => Math.round(fromTs + ((toTs - fromTs) * Number(b - from)) / span);
        const swaps: DecodedSwap[] = logs.map((l) => ({
          poolId: isV4 ? target : (target.toLowerCase() as `0x${string}`),
          block: l.blockNumber,
          ts: interpTs(l.blockNumber),
          amount0: l.args.amount0!,
          amount1: l.args.amount1!,
          sqrtPriceX96: l.args.sqrtPriceX96!,
          tick: l.args.tick!,
          fee: isV4 ? Number((l.args as { fee?: bigint | number }).fee ?? 0) : null,
        }));
        const stmts: D1PreparedStatement[] = [];
        for (const c of foldCandles(swaps)) {
          stmts.push(await this.mergedCandleUpsert(c));
          candleCount++;
        }
        if (stmts.length) await this.env.DB.batch(stmts);
        swapCount += swaps.length;
      }
      pages++;
      from = to + 1n;
      fromTs = toTs;
      await sleep(150); // pace the public RPC
    }
    return { fromBlock: Number(fromBlock), toBlock: Number(head), pages, swaps: swapCount, candles: candleCount };
  }

  /** Binary search the first block at/after a timestamp (on-demand blocks: spacing varies). */
  private async findBlockByTimestamp(targetTs: number, head: bigint): Promise<bigint> {
    let lo = 1n;
    let hi = head;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      const ts = Number((await this.rpc(() => this.client.getBlock({ blockNumber: mid }))).timestamp);
      if (ts < targetTs) lo = mid + 1n;
      else hi = mid;
    }
    return lo;
  }

  private async watchedV3Pools(): Promise<`0x${string}`[]> {
    const rows = await this.env.DB.prepare("SELECT address FROM v3_pools WHERE watched = 1").all<{
      address: string;
    }>();
    return rows.results.map((r) => r.address as `0x${string}`);
  }

  /** Exact per-block timestamps for live pages (few blocks), chunked to spare the RPC. */
  private async blockTimestamps(blocks: bigint[]): Promise<Map<bigint, number>> {
    const unique = [...new Set(blocks)];
    const out = new Map<bigint, number>();
    for (let i = 0; i < unique.length; i += 4) {
      await Promise.all(
        unique.slice(i, i + 4).map(async (b) => {
          const block = await this.rpc(() => this.client.getBlock({ blockNumber: b }));
          out.set(b, Number(block.timestamp));
        }),
      );
    }
    return out;
  }
}
