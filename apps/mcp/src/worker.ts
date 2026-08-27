// friar-mcp: remote MCP server (Streamable HTTP) exposing Friar to AI agents —
// including agents driving wallets via Robinhood's agentic platform. Read tools serve
// pool/position intelligence; build tools return UNSIGNED transactions {to, data,
// value, chainId} for the agent's wallet to sign. This server never touches keys, and
// like the REST API it is auth-free: everything here is public-chain-derived or pure
// encoding. The wallet is the only gate that matters.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import type { Address } from "viem";
import { ADDRESSES, poolId, robinhoodChain } from "@friar/chain";
import { FriarClient, type PlanOpenInput, type PlanSimpleOpenInput, type PoolKey, type TxRequest } from "@josephtaylor/friar-sdk";

type Env = {
  FriarMCP: DurableObjectNamespace;
  API_URL: string;
  RPC_URL: string;
};

const VERSION = "0.3.0"; // tracks @josephtaylor/friar-sdk

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "EVM address");
const wei = z.string().regex(/^\d+$/, "integer wei amount as a string");
const bpsArg = z.number().int().min(1).max(10_000);

const json = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x), 2);

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const errText = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true as const,
});

/** Serialize TxRequests with an explicit signing instruction agents can't miss. */
const txPayload = (txs: TxRequest[]) =>
  json({
    instructions:
      "Unsigned transactions. Sign and send each with the user's wallet IN ORDER (approvals before the manager call), on chain 4663. Do not alter data.",
    transactions: txs.map((t) => ({ ...t, value: t.value.toString() })),
  });

export class FriarMCP extends McpAgent<Env> {
  server = new McpServer(
    { name: "friar", version: VERSION },
    {
      instructions:
        "Friar is a DLMM (Dynamic Liquidity Market Maker) + LP position manager on Robinhood Chain (id 4663). " +
        "Positions are made of bins with a shape (spot | curve | bidask), or a single range ('simple'). " +
        "Flow for opening: friar_token_safety → friar_pool_state → friar_plan_open (preview) → friar_build_open (unsigned txs) → sign with the user's wallet. " +
        "Bring-your-own-pool: any v4 pool works — resolve a Dexscreener v4 pair id with friar_resolve_pool, then pass poolId to the plan/build tools. " +
        "Simple single-range positions: friar_plan_open_simple / friar_build_open_simple. " +
        "Manage with friar_positions / friar_position, friar_build_collect / _increase / _decrease / _close. " +
        "All build_* tools return unsigned {to, data, value, chainId} payloads; this server never signs. " +
        "The fee is a % of fees earned, charged on-chain at collection — 10% for shaped positions, 1% for simple (single-bin); principal is never charged. " +
        "Amounts are wei strings.",
    },
  );

  private friar!: FriarClient;

  async init() {
    this.friar = new FriarClient({ apiUrl: this.env.API_URL, rpcUrl: this.env.RPC_URL });
    const friar = this.friar;

    this.server.registerTool(
      "friar_chain_info",
      {
        description:
          "Robinhood Chain + Friar deployment facts: chain id, RPC, explorer, contract addresses (PoolManager, FriarPositionManager, hooks), quote tokens (WETH, USDG), and the fee model.",
        inputSchema: {},
      },
      async () =>
        text(
          json({
            chainId: robinhoodChain.id,
            name: robinhoodChain.name,
            rpc: this.env.RPC_URL,
            explorer: "https://explorer.mainnet.chain.robinhood.com",
            addresses: ADDRESSES,
            quoteTokens: {
              weth: { address: ADDRESSES.weth, note: "default quote" },
              usdg: { address: ADDRESSES.usdg, note: "the chain's dollar rail — USDG-quoted positions hold dollar inventory. Beware ticker impostors; only this address is canonical." },
            },
            feeModel:
              "Pools use the Friar hook's dynamic fee (volatility accumulator: low base fee in calm, surging in volatility). The position manager takes a 5% performance fee on fees earned, in-kind at collection. Principal is never charged.",
            signing: "All build_* tools return unsigned transactions for chain 4663; the user's wallet signs.",
          }),
        ),
    );

    this.server.registerTool(
      "friar_list_pools",
      {
        description:
          "All indexed Friar/v4 pools with 24h volume, swap count, last price, and open-position count.",
        inputSchema: {},
      },
      async () => {
        try {
          return text(json(await friar.api.pools()));
        } catch (e) {
          return errText(e);
        }
      },
    );

    this.server.registerTool(
      "friar_hot_tokens",
      {
        description:
          "Discovery board: hot Robinhood Chain tokens (volume, liquidity, mcap, price changes), each annotated with whether a Friar pool exists (friarPoolId) and whether Friar's fee floor undercuts the incumbent venue.",
        inputSchema: {},
      },
      async () => {
        try {
          return text(json(await friar.api.tokens()));
        } catch (e) {
          return errText(e);
        }
      },
    );

    this.server.registerTool(
      "friar_pool_state",
      {
        description:
          "Live pool state for a token/quote pair: price (sqrtPriceX96 + tick), whether the pool exists, and the CURRENT dynamic fee read from the Friar hook (dynamicFeePips, 10000 pips = 1%) — the live fee gauge static venues can't show.",
        inputSchema: { token: addr, quote: addr.optional() },
      },
      async ({ token, quote }) => {
        try {
          const r = await friar.poolState(token as Address, quote as Address | undefined);
          return text(
            json({
              poolId: poolId(r.key),
              key: r.key,
              quoteIs0: r.quoteIs0,
              live: r.state.live,
              sqrtPriceX96: r.state.sqrtPriceX96,
              tick: r.state.tick,
              dynamicFeePips: r.dynamicFeePips,
              dynamicFeePct: r.dynamicFeePips === null ? null : r.dynamicFeePips / 10_000,
            }),
          );
        } catch (e) {
          return errText(e);
        }
      },
    );

    this.server.registerTool(
      "friar_candles",
      {
        description:
          "OHLCV candles for a pool (v4 poolId) or incumbent v3 pool address. Interval in seconds (60/300/3600).",
        inputSchema: {
          id: z.string(),
          interval: z.number().int().positive().optional(),
          hours: z.number().positive().max(24 * 30).optional(),
        },
      },
      async ({ id, interval, hours }) => {
        try {
          const to = Math.floor(Date.now() / 1000);
          const from = to - Math.floor((hours ?? 24) * 3600);
          const candles = await friar.api.candles(id, { interval: interval ?? 3600, from, to });
          return text(json(candles));
        } catch (e) {
          return errText(e);
        }
      },
    );

    this.server.registerTool(
      "friar_token_safety",
      {
        description:
          "Malicious-token screen (Blockaid + GoPlus, cached 6h). level 'block' = honeypot/can't-sell/ruggable — do not LP it. Empty sources means UNCHECKED, not clean.",
        inputSchema: { token: addr },
      },
      async ({ token }) => {
        try {
          return text(json(await friar.api.tokenSafety(token)));
        } catch (e) {
          return errText(e);
        }
      },
    );

    this.server.registerTool(
      "friar_positions",
      {
        description:
          "All positions for an owner address, each with PnL summary decomposed as fees earned vs inventory delta vs net (quote-denominated wei strings).",
        inputSchema: { owner: addr },
      },
      async ({ owner }) => {
        try {
          return text(json(await friar.api.positions(owner)));
        } catch (e) {
          return errText(e);
        }
      },
    );

    this.server.registerTool(
      "friar_position",
      {
        description:
          "Full detail for one position (owner address required — reads are owner-keyed): bins, events, latest mark, PnL summary.",
        inputSchema: { positionId: z.number().int().nonnegative(), owner: addr },
      },
      async ({ positionId, owner }) => {
        try {
          return text(json(await friar.api.position(positionId, owner)));
        } catch (e) {
          return errText(e);
        }
      },
    );

    this.server.registerTool(
      "friar_position_onchain",
      {
        description:
          "Trustless position status straight from the chain (no Friar backend): the on-chain record (owner, pool, bins), pool state, and a mark at the POOL price. Works even if Friar's servers are down — the record alone is sufficient to exit. Caveat: a breached pool's tick can lag the real market; prefer friar_position for PnL truth.",
        inputSchema: { positionId: z.number().int().nonnegative() },
      },
      async ({ positionId }) => {
        try {
          return text(json(await friar.onChainStatus(BigInt(positionId))));
        } catch (e) {
          return errText(e);
        }
      },
    );

    const poolIdArg = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "v4 pool id (32-byte hex)");

    const refShape = {
      token: addr.optional().describe("token to LP on the standard Friar pool (or supply poolId instead)"),
      poolId: poolIdArg
        .optional()
        .describe("bring-your-own-pool: ANY v4 pool id (a Dexscreener v4 'pair address' is one). Overrides token."),
      quote: addr
        .optional()
        .describe("quote token orienting depths/budgets; defaults to WETH (token flow) or the pool's rail side (poolId flow)"),
    };

    /** poolId|token → the PoolRef fragment the SDK planners take. */
    const refFrom = async (a: { poolId?: string | undefined; token?: string | undefined; quote?: string | undefined }) => {
      if (a.poolId) {
        const r = await friar.poolById(a.poolId as `0x${string}`);
        if (!r) throw new Error(`no v4 pool with id ${a.poolId} on Robinhood Chain`);
        return { pool: r.key, ...(a.quote ? { quote: a.quote as Address } : {}) };
      }
      if (!a.token) throw new Error("supply token or poolId");
      return { token: a.token as Address, ...(a.quote ? { quote: a.quote as Address } : {}) };
    };

    /** Safety screen for a build: the token side, or BOTH sides of a brought pool. */
    const screenRef = async (ref: { pool?: PoolKey; token?: Address }) => {
      const targets = ref.pool ? [ref.pool.currency0, ref.pool.currency1] : [ref.token!];
      for (const t of targets) {
        const safety = await friar.api.tokenSafety(t).catch(() => null);
        if (safety?.level === "block") {
          throw new Error(`token ${t} is hard-flagged by the safety screen (${safety.flags.join(", ")}) — refusing to build an open`);
        }
      }
    };

    const depthShape = {
      depthBelowPct: z.number().min(0).max(99).describe("price depth covered below spot (quote side), %"),
      depthAbovePct: z.number().min(0).max(300).describe("price depth covered above spot (token side), %"),
      amountQuote: wei.describe("quote-token budget, wei"),
      amountBase: wei.describe("base-token budget, wei"),
      initSqrtPriceX96: wei.optional().describe("only for creating a brand-new pool (openNew): initial sqrtPriceX96"),
    };

    const planShape = {
      ...refShape,
      shape: z.enum(["spot", "curve", "bidask"]).describe("spot = uniform, curve = concentrated near price, bidask = weighted to the edges"),
      ...depthShape,
    };

    const toShapeFields = (a: {
      shape: "spot" | "curve" | "bidask";
      depthBelowPct: number;
      depthAbovePct: number;
      amountQuote: string;
      amountBase: string;
      initSqrtPriceX96?: string | undefined;
    }): Omit<PlanOpenInput, "token" | "pool" | "quote" | "spacing"> => ({
      shape: a.shape,
      depthBelowPct: a.depthBelowPct,
      depthAbovePct: a.depthAbovePct,
      amountQuote: BigInt(a.amountQuote),
      amountBase: BigInt(a.amountBase),
      ...(a.initSqrtPriceX96 ? { initSqrtPriceX96: BigInt(a.initSqrtPriceX96) } : {}),
    });

    const toSimpleFields = (a: {
      depthBelowPct: number;
      depthAbovePct: number;
      amountQuote: string;
      amountBase: string;
      initSqrtPriceX96?: string | undefined;
    }): Omit<PlanSimpleOpenInput, "token" | "pool" | "quote" | "spacing"> => ({
      depthBelowPct: a.depthBelowPct,
      depthAbovePct: a.depthAbovePct,
      amountQuote: BigInt(a.amountQuote),
      amountBase: BigInt(a.amountBase),
      ...(a.initSqrtPriceX96 ? { initSqrtPriceX96: BigInt(a.initSqrtPriceX96) } : {}),
    });

    this.server.registerTool(
      "friar_plan_open",
      {
        description:
          "Plan a position without building transactions: compiles shape + depths + budgets into bins and reports the exact token deposits required (needs0/needs1, in pool currency order). Single-sided plans (depth 0 on one side) need only one token — no swap ever required. Preview this before friar_build_open.",
        inputSchema: planShape,
      },
      async (a) => {
        try {
          const plan = await friar.planOpen({ ...(await refFrom(a)), ...toShapeFields(a) });
          return text(
            json({
              summary: plan.summary,
              poolId: poolId(plan.key),
              poolLive: plan.poolLive,
              quoteIs0: plan.quoteIs0,
              binCount: plan.contractBins.length,
              needs0: plan.needs0,
              needs1: plan.needs1,
              maxPay0: plan.maxPay0,
              maxPay1: plan.maxPay1,
              note: "needs0/needs1 are in pool currency order (currency0, currency1). quoteIs0 tells you which is the quote.",
              bins: plan.bins.map((b) => ({
                side: b.side,
                tickLower: b.tickLower,
                tickUpper: b.tickUpper,
                liquidity: b.liquidity,
                amount: b.amount,
              })),
            }),
          );
        } catch (e) {
          return errText(e);
        }
      },
    );

    this.server.registerTool(
      "friar_build_open",
      {
        description:
          "Build the unsigned transactions to open a position (or create a new pool + seed it, when the pool doesn't exist and initSqrtPriceX96 is given): any needed ERC-20 approvals plus the open/openNew call, in signing order. Refuses tokens the safety screen hard-flags.",
        inputSchema: { ...planShape, owner: addr.describe("the wallet address that will sign — used to check current allowances") },
      },
      async (a) => {
        try {
          const ref = await refFrom(a);
          await screenRef(ref);
          const plan = await friar.planOpen({ ...ref, ...toShapeFields(a) });
          const txs = await friar.openTxs(plan, a.owner as Address);
          return text(txPayload(txs));
        } catch (e) {
          return errText(e);
        }
      },
    );

    this.server.registerTool(
      "friar_resolve_pool",
      {
        description:
          "Bring-your-own-pool: resolve a v4 pool id (Dexscreener v4 'pair address' = the pool id) to its full PoolKey, live state, and a hook-safety verdict. Hooks that run on liquidity removal are level 'block' — they can trap or tax exits, and the plan/build tools will refuse them.",
        inputSchema: { poolId: poolIdArg },
      },
      async ({ poolId: id }) => {
        try {
          const r = await friar.poolById(id as `0x${string}`);
          if (!r) return errText(new Error(`no v4 pool with id ${id} on Robinhood Chain`));
          return text(
            json({
              key: r.key,
              live: r.state.live,
              tick: r.state.tick,
              sqrtPriceX96: r.state.sqrtPriceX96,
              lpFeePips: r.state.lpFee,
              hook: { level: r.verdict.level, flags: r.verdict.flags, reasons: r.verdict.reasons },
              note: "pass this poolId to friar_plan_open / friar_build_open (shaped) or the _simple variants (one range)",
            }),
          );
        } catch (e) {
          return errText(e);
        }
      },
    );

    this.server.registerTool(
      "friar_plan_open_simple",
      {
        description:
          "Plan a SIMPLE position — one range spanning [-below%, +above%], a single bin (v3-style). Pays the manager's 1% simple fee tier (vs 10% shaped). Works on the standard Friar pool (token) or any v4 pool (poolId). Deposit-both semantics; a depth of 0 on one side makes it single-token.",
        inputSchema: { ...refShape, ...depthShape },
      },
      async (a) => {
        try {
          const plan = await friar.planSimpleOpen({ ...(await refFrom(a)), ...toSimpleFields(a) });
          const bin = plan.contractBins[0]!;
          return text(
            json({
              summary: plan.summary,
              poolId: poolId(plan.key),
              poolLive: plan.poolLive,
              quoteIs0: plan.quoteIs0,
              range: { tickLower: bin.tickLower, tickUpper: bin.tickUpper, liquidity: bin.liquidity },
              needs0: plan.needs0,
              needs1: plan.needs1,
              maxPay0: plan.maxPay0,
              maxPay1: plan.maxPay1,
              hook: plan.hookVerdict,
              note: "needs0/needs1 are in pool currency order (currency0, currency1). quoteIs0 tells you which is the quote.",
            }),
          );
        } catch (e) {
          return errText(e);
        }
      },
    );

    this.server.registerTool(
      "friar_build_open_simple",
      {
        description:
          "Build the unsigned transactions for a SIMPLE (single-range) position: approvals + open, in signing order. Same targeting as friar_plan_open_simple (token or poolId). Refuses safety-flagged tokens and pools with exit-unsafe hooks.",
        inputSchema: { ...refShape, ...depthShape, owner: addr.describe("the wallet address that will sign — used to check current allowances") },
      },
      async (a) => {
        try {
          const ref = await refFrom(a);
          await screenRef(ref);
          const plan = await friar.planSimpleOpen({ ...ref, ...toSimpleFields(a) });
          const txs = await friar.openTxs(plan, a.owner as Address);
          return text(txPayload(txs));
        } catch (e) {
          return errText(e);
        }
      },
    );

    this.server.registerTool(
      "friar_build_increase",
      {
        description:
          "Build unsigned transactions to grow an existing position by a percentage of its current liquidity (addBps: 5000 = +50%), including any needed approvals.",
        inputSchema: {
          positionId: z.number().int().nonnegative(),
          addBps: bpsArg.describe("basis points of current liquidity to add (10000 = double)"),
          owner: addr,
        },
      },
      async ({ positionId, addBps, owner }) => {
        try {
          const txs = await friar.increaseTxs(BigInt(positionId), BigInt(addBps), owner as Address);
          return text(txPayload(txs));
        } catch (e) {
          return errText(e);
        }
      },
    );

    this.server.registerTool(
      "friar_build_decrease",
      {
        description:
          "Build an unsigned transaction to withdraw a percentage of a position (bps: 2500 = 25%). For a full exit use friar_build_close instead. minReceive0/1 are slippage floors in wei. The on-chain pay caps are always 0 here: an exit built by this tool can never charge the owner, only pay out.",
        inputSchema: {
          positionId: z.number().int().nonnegative(),
          bps: bpsArg,
          minReceive0: wei.optional(),
          minReceive1: wei.optional(),
        },
      },
      async ({ positionId, bps, minReceive0, minReceive1 }) => {
        try {
          const tx = await friar.decreaseTx(BigInt(positionId), BigInt(bps), {
            ...(minReceive0 ? { minReceive0: BigInt(minReceive0) } : {}),
            ...(minReceive1 ? { minReceive1: BigInt(minReceive1) } : {}),
          });
          return text(txPayload([tx]));
        } catch (e) {
          return errText(e);
        }
      },
    );

    this.server.registerTool(
      "friar_build_close",
      {
        description:
          "Build an unsigned transaction to fully close a position: burns all bins, auto-collects fees (10% perf fee on the fees, in-kind), returns both tokens, deletes the record. The on-chain pay caps are always 0 here: an exit built by this tool can never charge the owner, only pay out.",
        inputSchema: {
          positionId: z.number().int().nonnegative(),
          minReceive0: wei.optional(),
          minReceive1: wei.optional(),
        },
      },
      async ({ positionId, minReceive0, minReceive1 }) => {
        try {
          const tx = await friar.closeTx(BigInt(positionId), {
            ...(minReceive0 ? { minReceive0: BigInt(minReceive0) } : {}),
            ...(minReceive1 ? { minReceive1: BigInt(minReceive1) } : {}),
          });
          return text(txPayload([tx]));
        } catch (e) {
          return errText(e);
        }
      },
    );

    this.server.registerTool(
      "friar_build_collect",
      {
        description:
          "Build an unsigned transaction to claim a position's accrued fees without touching liquidity. The 10% perf fee is taken here, in-kind; principal is never charged.",
        inputSchema: { positionId: z.number().int().nonnegative() },
      },
      async ({ positionId }) => {
        try {
          const tx = await friar.collectTx(BigInt(positionId));
          return text(txPayload([tx]));
        } catch (e) {
          return errText(e);
        }
      },
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return Response.json({
        name: "friar-mcp",
        version: VERSION,
        transport: { streamableHttp: "/mcp", sse: "/sse (legacy)" },
        docs: "https://friar.fi",
        note: "Remote MCP server for Friar on Robinhood Chain (4663). Read tools + unsigned transaction builders; connect any MCP client and sign with your own wallet.",
      });
    }
    if (url.pathname.startsWith("/mcp")) {
      return FriarMCP.serve("/mcp", { binding: "FriarMCP" }).fetch(request, env, ctx);
    }
    if (url.pathname.startsWith("/sse")) {
      return FriarMCP.serveSSE("/sse", { binding: "FriarMCP" }).fetch(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
};
