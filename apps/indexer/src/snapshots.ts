// 5-minute snapshot cron: mark every open position and record the series that
// powers portfolio/PnL history. Marks use the pool price AND, when a ref venue is
// configured, the true market price — a breached pool's tick freezes and lies.
import { type PublicClient, type Hex } from "viem";
import { rpcClient } from "./rpc.js";
import { markPosition, unclaimedFees, markPrice1e18, type MarkableBin } from "@friar/core";
import { binSalt, stateViewAbi, managerForPosition, ADDRESSES } from "@friar/chain";
import type { Env } from "./worker.js";

interface OpenPositionRow {
  position_id: number;
  pool_id: string;
  owner: string;
  currency0: string;
  ref_pool: string | null;
  /** Owning manager — v4 position keys are salted per manager, so fee reads must use
   * the position's OWN deployment, not whichever one is current. */
  manager: string | null;
}

interface BinRow {
  bin_index: number;
  tick_lower: number;
  tick_upper: number;
  liquidity: string;
}

// Every bin needs a pair of StateView reads, and a position can hold up to MAX_BINS of
// them. Sent as loose eth_calls that is hundreds of requests per pass: the public
// sequencer RPC answers "Too Many Requests" well before they finish, and with an
// unbounded Promise.all ONE rejection was fatal to the whole pass. That is exactly how
// three open positions (183 bins → 366 calls) froze every snapshot for an hour on
// 2026-07-25 — candles stayed fresh, unclaimed fees read 0, and the fees were on-chain
// the whole time. Now: two Multicall3 aggregates per position, so a 100-bin position
// costs ~2 requests instead of 200, and failures are isolated per position.
const MULTICALL_BATCH_BYTES = 16_384; // big enough that MAX_BINS fits in one aggregate

/** Even aggregated, the sequencer can rate-limit a burst; one blip should not cost a
 * position its mark for the next 5 minutes. Two short retries. */
async function withRetry<R>(fn: () => Promise<R>): Promise<R> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
}

export async function runSnapshots(env: Env): Promise<void> {
  // Ref venue for true-market marks: an explicit pools.ref_pool pin wins; otherwise
  // fall back to the token's scanned incumbent venue (deepest factory-verified v3/v2
  // WETH pair) — but ONLY for WETH-quoted pools, since the incumbent is WETH-quoted
  // and a USDG-pair position judged in WETH units would be nonsense. Resolved live
  // each pass so it tracks depth migrating between venues.
  const weth = ADDRESSES.weth.toLowerCase();
  const positions = await env.DB.prepare(
    `SELECT p.position_id, p.pool_id, p.manager, p.owner, pl.currency0,
            COALESCE(pl.ref_pool,
                     CASE WHEN LOWER(pl.currency0) = ?1 OR LOWER(pl.currency1) = ?1 THEN t.incumbent_pool END) AS ref_pool
     FROM positions p
     JOIN pools pl ON pl.pool_id = p.pool_id
     LEFT JOIN tokens t ON t.address = LOWER(CASE WHEN LOWER(pl.currency0) = ?1 THEN pl.currency1 ELSE pl.currency0 END)
     WHERE p.closed_ts IS NULL`,
  )
    .bind(weth)
    .all<OpenPositionRow>();
  if (!positions.results.length) return;

  // no JSON-RPC batching — the Robinhood RPC rejects batch arrays (Multicall3 is how
  // this pass stays cheap; see rpc.ts for why RPC_URL is a fallback list)
  const client = rpcClient(env);
  const ts = Math.floor(Date.now() / 1000);

  // One slot0 per distinct pool, aggregated into a SINGLE request. These used to be
  // sequential eth_calls inside a silent `catch {}`: once the RPC started rate-limiting,
  // whichever pool came second onwards was dropped with no log, and its positions went
  // unmarked invisibly. allowFailure keeps one bogus pool id from killing the pass, and
  // every drop is now logged.
  const poolIds = [...new Set(positions.results.map((p) => p.pool_id))];
  const aggregate = { multicallAddress: ADDRESSES.multicall3, batchSize: MULTICALL_BATCH_BYTES } as const;
  const slot0s = await withRetry(() =>
    client.multicall({
      ...aggregate,
      allowFailure: true,
      contracts: poolIds.map((id) => ({
        address: ADDRESSES.stateView,
        abi: stateViewAbi,
        functionName: "getSlot0" as const,
        args: [id as Hex] as const,
      })),
    }),
  );

  // Ref-venue prices are heterogeneous (v3 slot0 vs v2 getReserves) and each is a single
  // call, so they stay individual — but a ref failure must only cost the TRUE-MARKET
  // price, never the mark itself, so it falls back to the pool price below.
  const refPrices = new Map<string, bigint | null>();
  for (const ref of new Set(positions.results.map((p) => p.ref_pool).filter((r): r is string => !!r)))
    refPrices.set(ref, await refSqrtPrice(client, ref as `0x${string}`));

  const poolPrices = new Map<string, { sqrtPrice: bigint; marketSqrtPrice: bigint | null }>();
  poolIds.forEach((id, i) => {
    const r = slot0s[i]!;
    if (r.status !== "success") {
      console.error(`snapshot: unreadable pool ${id}: ${String(r.error)}`);
      return;
    }
    const ref = positions.results.find((p) => p.pool_id === id)?.ref_pool ?? null;
    poolPrices.set(id, { sqrtPrice: r.result[0], marketSqrtPrice: (ref && refPrices.get(ref)) || null });
  });

  const stmts: D1PreparedStatement[] = [];
  const E18 = 10n ** 18n;
  // Per-owner NAV legs. All-or-nothing per OWNER, mirroring the per-position rule: any
  // skipped/unpriceable position would understate its owner's NAV, so that owner sits
  // this pass out rather than recording a lie.
  const navPositions = new Map<string, bigint>();
  const navSkipOwners = new Set<string>();
  for (const p of positions.results) {
    if (!poolPrices.has(p.pool_id)) {
      navSkipOwners.add(p.owner);
      continue;
    }
    const binRows = await env.DB.prepare(
      "SELECT bin_index, tick_lower, tick_upper, liquidity FROM position_bins WHERE position_id = ? AND liquidity != '0'",
    )
      .bind(p.position_id)
      .all<BinRow>();
    if (!binRows.results.length) continue;

    // A partial read would understate the mark, so a position is all-or-nothing — but
    // only for ITSELF. Skipping it must never cost the other positions their snapshot;
    // the next pass retries in 5 minutes.
    // Two homogeneous aggregates (one per StateView function) keep the result arrays
    // index-aligned with binRows — no interleaving to unpick.
    const aggregate = { allowFailure: false, multicallAddress: ADDRESSES.multicall3, batchSize: MULTICALL_BATCH_BYTES } as const;
    let bins: MarkableBin[];
    try {
      const [insides, infos] = await Promise.all([
        withRetry(() =>
          client.multicall({
            ...aggregate,
            contracts: binRows.results.map((b) => ({
              address: ADDRESSES.stateView,
              abi: stateViewAbi,
              functionName: "getFeeGrowthInside" as const,
              args: [p.pool_id as Hex, b.tick_lower, b.tick_upper] as const,
            })),
          }),
        ),
        withRetry(() =>
          client.multicall({
            ...aggregate,
            contracts: binRows.results.map((b) => ({
              address: ADDRESSES.stateView,
              abi: stateViewAbi,
              functionName: "getPositionInfo" as const,
              args: [
                p.pool_id as Hex,
                managerForPosition(p).address,
                b.tick_lower,
                b.tick_upper,
                binSalt(BigInt(p.position_id), BigInt(b.bin_index)),
              ] as const,
            })),
          }),
        ),
      ]);
      bins = binRows.results.map((b, i) => {
        // CHAIN liquidity, not `b.liquidity` from D1. The row is a cache of the open
        // events and it goes stale for the seconds between a burn landing on-chain and
        // this indexer processing the close, which is exactly when this pass can run:
        // all five corrupt snapshots ever written landed 3 to 42 seconds after their
        // position closed. In that window `getFeeGrowthInside` is read against a
        // `feeGrowthInsideLast` the burn has already advanced, so the delta underflows,
        // `wrapSub` wraps it to ~2^256, and multiplying by a stale non-zero liquidity
        // produced fees of ~1e59. Chain liquidity is 0 there, so the bin marks to zero.
        const [chainLiquidity, last0, last1] = infos[i]!;
        const [inside0, inside1] = insides[i]!;
        const fees = unclaimedFees(
          chainLiquidity,
          { feeGrowthInside0X128: inside0, feeGrowthInside1X128: inside1 },
          { feeGrowthInside0LastX128: last0, feeGrowthInside1LastX128: last1 },
        );
        return {
          tickLower: b.tick_lower,
          tickUpper: b.tick_upper,
          liquidity: chainLiquidity,
          fees0: fees.fees0,
          fees1: fees.fees1,
        };
      });
      // Every bin empty on-chain = the position is being closed and the close event has
      // not been indexed yet. Its value is in flight, so it neither gets a snapshot nor
      // silently contributes 0 to its owner's NAV — the same all-or-nothing rule the
      // unreadable-position path below uses.
      if (bins.every((b) => b.liquidity === 0n)) {
        navSkipOwners.add(p.owner);
        continue;
      }
    } catch (err) {
      // A partial read would understate the mark, so a position is all-or-nothing — but
      // only for ITSELF. The next pass retries in 5 minutes.
      console.error(`snapshot: skipping position ${p.position_id}: ${String(err)}`);
      navSkipOwners.add(p.owner);
      continue;
    }

    const prices = poolPrices.get(p.pool_id)!;
    const mark = markPosition(bins, prices.marketSqrtPrice ?? prices.sqrtPrice);
    // NAV accumulation: quote-unit value of this mark + unclaimed fees NET of the
    // owning manager's perf cut (tiered managers split on bin count — the live bins are
    // a faithful proxy for count-at-open in practice).
    {
      const q0 = p.currency0.toLowerCase() === weth || p.currency0.toLowerCase() === ADDRESSES.usdg.toLowerCase();
      const px = markPrice1e18(prices.marketSqrtPrice ?? prices.sqrtPrice);
      if (px > 0n) {
        const fm = managerForPosition(p).feeModel;
        const perfPct = fm.kind === "flat" ? fm.pct : binRows.results.length === 1 ? fm.simplePct : fm.shapedPct;
        const keep = BigInt(Math.round((100 - perfPct) * 100)); // e.g. 95% → 9500
        const value = q0 ? mark.amount0 + (mark.amount1 * E18) / px : mark.amount1 + (mark.amount0 * px) / E18;
        const feesGross = q0 ? mark.fees0 + (mark.fees1 * E18) / px : mark.fees1 + (mark.fees0 * px) / E18;
        navPositions.set(p.owner, (navPositions.get(p.owner) ?? 0n) + value + (feesGross * keep) / 10_000n);
      } else {
        navSkipOwners.add(p.owner); // unpriceable mark would understate this owner's NAV
      }
    }
    stmts.push(
      env.DB.prepare(
        "INSERT OR REPLACE INTO snapshots (position_id, ts, sqrt_price, market_sqrt_price, amount0, amount1, fees0, fees1) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        p.position_id,
        ts,
        prices.sqrtPrice.toString(),
        prices.marketSqrtPrice?.toString() ?? null,
        mark.amount0.toString(),
        mark.amount1.toString(),
        mark.fees0.toString(),
        mark.fees1.toString(),
      ),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);

  // ---- NAV snapshots: liquid legs in ONE multicall, then one row per clean owner ----
  const owners = [...navPositions.keys()].filter((o) => !navSkipOwners.has(o));
  if (!owners.length) return;
  try {
    const balAbi = [
      { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
      { type: "function", name: "getEthBalance", stateMutability: "view", inputs: [{ name: "addr", type: "address" }], outputs: [{ type: "uint256" }] },
    ] as const;
    const legs = await withRetry(() =>
      client.multicall({
        multicallAddress: ADDRESSES.multicall3,
        batchSize: MULTICALL_BATCH_BYTES,
        allowFailure: true,
        contracts: owners.flatMap((o) => [
          { address: ADDRESSES.weth, abi: balAbi, functionName: "balanceOf" as const, args: [o as `0x${string}`] as const },
          { address: ADDRESSES.multicall3, abi: balAbi, functionName: "getEthBalance" as const, args: [o as `0x${string}`] as const },
        ]),
      }),
    );
    const bags = await ownerTokenBags(env, client, owners);
    const navStmts: D1PreparedStatement[] = [];
    owners.forEach((o, i) => {
      const w = legs[i * 2]!;
      const n = legs[i * 2 + 1]!;
      if (w.status !== "success" || n.status !== "success") return; // this owner sits the pass out
      const liquid = (w.result as bigint) + (n.result as bigint);
      const pos = navPositions.get(o) ?? 0n;
      const bag = bags.get(o.toLowerCase()) ?? 0n;
      navStmts.push(
        env.DB.prepare("INSERT OR REPLACE INTO nav_snapshots (owner, ts, liquid, positions, bags, nav) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(o.toLowerCase(), ts, liquid.toString(), pos.toString(), bag.toString(), (liquid + pos + bag).toString()),
      );
    });
    if (navStmts.length) await env.DB.batch(navStmts);
  } catch (err) {
    console.error(`nav snapshots failed (positions still snapshotted): ${String(err)}`);
  }
}

/** True-market reference read → sqrtPriceX96. Handles both venue kinds the scan can
 * resolve: v3 pool (slot0) and v2 pair (getReserves → equivalent sqrtPrice). Both
 * sort token0/token1 by address exactly like v4 currencies, so the price is directly
 * comparable to our pool's sqrtPriceX96 — no reorientation needed. */
async function refSqrtPrice(client: PublicClient, pool: `0x${string}`): Promise<bigint | null> {
  try {
    const data = await client.call({ to: pool, data: "0x3850c7bd" }); // v3 slot0()
    if (data.data && data.data.length >= 66) return BigInt(data.data.slice(0, 66));
  } catch {
    /* not a v3 pool — try v2 below */
  }
  try {
    const data = await client.call({ to: pool, data: "0x0902f1ac" }); // v2 getReserves()
    if (!data.data || data.data.length < 130) return null;
    const r0 = BigInt("0x" + data.data.slice(2, 66));
    const r1 = BigInt("0x" + data.data.slice(66, 130));
    if (r0 === 0n || r1 === 0n) return null;
    return isqrt((r1 << 192n) / r0); // sqrt(price1/0) in X96
  } catch {
    return null;
  }
}

/** Floor integer sqrt (Newton) for uint256-scale bigints. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

/**
 * Loose token balances per owner, valued in the quote rail.
 *
 * The token set is every non-quote side the owner has ever held a position in, OPEN OR
 * CLOSED — closed matters most, because that is exactly how a bag appears: an exit with no
 * zap venue and no sweep venue hands the position back in kind and it sits in the wallet
 * until a sweep can sell it. Pricing comes from the board's `price_native` (WETH per
 * token); a token with no price contributes 0, which understates rather than invents.
 */
async function ownerTokenBags(
  env: Env,
  client: PublicClient,
  owners: string[],
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (!owners.length) return out;
  const weth = ADDRESSES.weth.toLowerCase();
  const placeholders = owners.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT DISTINCT LOWER(p.owner) AS owner,
            LOWER(CASE WHEN LOWER(pl.currency0) = ?1 THEN pl.currency1 ELSE pl.currency0 END) AS token,
            t.price_native AS price
       FROM positions p
       JOIN pools pl ON pl.pool_id = p.pool_id
       LEFT JOIN tokens t ON t.address = LOWER(CASE WHEN LOWER(pl.currency0) = ?1 THEN pl.currency1 ELSE pl.currency0 END)
      WHERE LOWER(p.owner) IN (${placeholders})
        AND (LOWER(pl.currency0) = ?1 OR LOWER(pl.currency1) = ?1)`,
  )
    .bind(weth, ...owners.map((o) => o.toLowerCase()))
    .all<{ owner: string; token: string; price: number | null }>();
  const pairs = rows.results.filter((r) => r.token && r.token !== weth);
  if (!pairs.length) return out;
  // Bounded on purpose: this runs every 5 minutes and shares the RPC with position
  // marking. Past the cap the bag legs are skipped and NAV is liquid+positions, same as
  // before this existed — logged, never silently truncated.
  const CAP = 400;
  if (pairs.length > CAP) {
    console.warn(`nav bags: ${pairs.length} owner/token legs exceeds cap ${CAP} — bags skipped this pass`);
    return out;
  }
  const balAbi = [
    { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  ] as const;
  const res = await client.multicall({
    multicallAddress: ADDRESSES.multicall3,
    batchSize: MULTICALL_BATCH_BYTES,
    allowFailure: true,
    contracts: pairs.map((p) => ({
      address: p.token as `0x${string}`,
      abi: balAbi,
      functionName: "balanceOf" as const,
      args: [p.owner as `0x${string}`] as const,
    })),
  });
  pairs.forEach((p, i) => {
    const r = res[i];
    if (!r || r.status !== "success") return;
    const bal = r.result as bigint;
    if (bal === 0n || !p.price || !(p.price > 0)) return;
    // price is WETH-per-token as a float; scale through 1e6 to stay in integer math
    const valued = (bal * BigInt(Math.round(p.price * 1e6))) / 1_000_000n;
    out.set(p.owner, (out.get(p.owner) ?? 0n) + valued);
  });
  return out;
}
