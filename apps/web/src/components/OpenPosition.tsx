import { useEffect, useMemo, useRef, useState } from "react";
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
  useBalance,
  useCapabilities,
  useSendCalls,
  useCallsStatus,
} from "wagmi";
import { erc20Abi, parseUnits, encodeFunctionData, parseEventLogs, type Address, type Hex, type Log } from "viem";
import { friarPositionManagerAbi, ADDRESSES, robinhoodChain, DYNAMIC_FEE_FLAG, FRIAR_V2_SPACINGS, deployedFeeTiers, currentManager, perfFeeCopy, poolId } from "@friar/chain";
import { getTickAtSqrtPrice } from "@friar/core";
import type { Shape } from "@friar/core";
import { binModel, BinBars, type ChartBin } from "./BinChart.js";
import { TokenMarket } from "./TokenMarket.js";
import { useQuery } from "@tanstack/react-query";
import {
  fetchToken,
  fetchTokenSafety,
  planOpen,
  poolKeyFor,
  discoverFriarPools,
  prettyRiskFlags,
  publicClient,
  defaultSpacingFor,
  v2RouterAbi,
  v3RouterAbi,
  parsePastedTarget,
  resolvePastedPool,
  probePairAddress,
  type TokenInfo,
  type OpenPlan,
  type ResolvedPool,
  type FriarPoolOption,
} from "../plan.js";
import { fmtQuote, fmtAmount } from "../api.js";
import { preflight } from "../preflight.js";
import { useTokenSymbol } from "../tokens.js";
import { track } from "../analytics.js";
import { DOCS_OPENING } from "../links.js";
import { humanErr, report } from "../errors.js";
import { explainTimeout } from "../txprobe.js";

const FPM = ADDRESSES.positionManager as Address;
const MAX_UINT256 = (1n << 256n) - 1n; // one-time (unlimited) allowance

/**
 * The manager verb + args for a plan. Base fee lives in the FriarTier hook (not config), so
 * there are only two verbs: `open` into a live pool, or `openNew` to create one at the chosen
 * (tier hook, spacing) and mint atomically. No configured-open path.
 */
function buildOpenCall(plan: OpenPlan): { functionName: "open" | "openNew"; args: unknown[] } {
  const swapIn = {
    enabled: plan.swapIn.enabled,
    venue: plan.swapIn.venue,
    zeroForOne: plan.swapIn.zeroForOne,
    amountIn: plan.swapIn.amountIn,
    minAmountOut: plan.swapIn.minAmountOut,
    sqrtPriceLimitX96: plan.swapIn.sqrtPriceLimitX96,
  };
  if (plan.pool.live) return { functionName: "open", args: [plan.key, plan.contractBins, swapIn, plan.maxPay0, plan.maxPay1] };
  return { functionName: "openNew", args: [plan.key, plan.initSqrtPrice!, plan.contractBins, swapIn, plan.maxPay0, plan.maxPay1] };
}
// Wrapping ETH → WETH, in-flow. Chain natives hold ETH, not WETH, and every Friar pool is
// quoted in WETH or USDG — so before this existed the app told a funded wallet "wrap ETH
// first" and disabled the button. Measured 2026-07-26: of the strangers who configured a
// position, one held 19 ETH across 639 transactions on this chain and still couldn't open.
const wethAbi = [{ type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] }] as const;
// Left unwrapped to pay for the remaining steps. Gas is cents on this chain; this is just
// enough that wrapping can never strand someone mid-flow.
const GAS_RESERVE = 10n ** 15n; // 0.001 ETH
// a ghost pool stuck near MAX_TICK is astronomically "off market" — cap the display so it
// reads ">1000%" instead of 4.5e35%.
const fmtDrift = (pct: number) => (pct >= 1000 ? ">1000%" : `${Math.round(pct)}%`);
export const INDEXER_BASE =
  (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_INDEXER_URL ?? "http://localhost:8790";

const SHAPES: Array<{ v: Shape; label: string }> = [
  { v: "spot", label: "Spot" },
  { v: "curve", label: "Curve" },
  { v: "bidask", label: "Bid-Ask" },
];
// GMGN kline interval codes for the timeframe chips
const GMGN_INTERVAL: Record<string, string> = { "5m": "5", "15m": "15", "1h": "60", "4h": "240" };
const PRESETS = [
  { label: "±5%", below: "5", above: "5" },
  { label: "±10%", below: "10", above: "10" },
  { label: "30 / 10", below: "30", above: "10" },
  { label: "wide", below: "50", above: "50" },
  { label: "binchicken", below: "40", above: "8", shape: "bidask" as Shape, wing: "8" },
];

export function OpenPosition({
  prefillToken,
  prefillQuote,
  prefillPool,
  backLabel = "Positions",
  onBack,
  onDone,
}: {
  prefillToken?: string;
  prefillQuote?: "WETH" | "USDG";
  /** A specific existing pool to preselect (its poolId), e.g. arriving from the Pools page —
   * lands the selector on that pool (a join) instead of the deepest default. */
  prefillPool?: string;
  /** the screen the crumb points back at — named after where this open was entered from */
  backLabel?: string;
  onBack?: () => void;
  onDone: (positionId?: number) => void;
}) {
  const { address } = useAccount();
  // the whole screen is browsable by anyone — admittance gates only the submit below
  const [tokenAddr, setTokenAddr] = useState(prefillToken ?? "");
  const [token, setToken] = useState<TokenInfo | null>(null);
  const [tokenErr, setTokenErr] = useState<string | null>(null);
  // bring-your-own-pool: set when a v4 pool id was pasted; the pool (not token+quote
  // candidates) then pins the pair, the fee tier, and the quote orientation
  const [xpool, setXpool] = useState<ResolvedPool | null>(null);
  const [quoteInfo, setQuoteInfo] = useState<TokenInfo | null>(null); // xpool's quote side
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  // Simple = ONE bin spanning the range · Shaped = Spot/Curve/Bid-Ask (same flat perf fee)
  const [style, setStyle] = useState<"simple" | "shaped">("shaped");

  const [shape, setShape] = useState<Shape>("bidask");
  const [below, setBelow] = useState("30");
  const [above, setAbove] = useState("10");
  const [mode, setMode] = useState<"both" | "zap">("zap");
  // Pool selection. The dropdown lists the pair's EXISTING Friar pools (so an LP joins one
  // from a list, never guesses a combo), with "Create a new pool" as the last option. Picking
  // create reveals the fee-tier + bin-width controls. Empty string = use the default (deepest
  // existing pool, or create when none exist).
  const NEW_POOL = "__new__";
  const tiers = deployedFeeTiers();
  const [poolSel, setPoolSel] = useState<string>(""); // "" = default, a poolId, or NEW_POOL
  // Create-a-new-pool defaults: 1% base fee + 1% bins (spacing 100).
  const [feeHookSel, setFeeHookSel] = useState<string>(tiers.find((t) => t.pct === 1)?.hook ?? tiers[0]?.hook ?? "");
  const [spacingInput, setSpacingInput] = useState("100"); // spacing 100 = 1.0% bins
  const [amtQuote, setAmtQuote] = useState(prefillQuote === "USDG" ? "20" : "0.1");
  const [amtBase, setAmtBase] = useState("0");
  const [wingPct, setWingPct] = useState("8");
  const [tf, setTf] = useState("15m"); // GMGN kline default timeframe
  // quote/base token the position pairs against — WETH or USDG (6-dec). Same zap
  // semantics either way; the base token just changes. The board prefills USDG for
  // stock tokens (their venues are USDG-quoted).
  const [quoteSel, setQuoteSel] = useState<"WETH" | "USDG">(prefillQuote ?? "WETH");
  // a brought pool pins its own quote side (any token); the segmented rail picker only
  // drives the token-first flow
  const quoteAddr = xpool ? (xpool.quoteAddress as Address) : ((quoteSel === "USDG" ? ADDRESSES.usdg : ADDRESSES.weth) as Address);
  const quoteDecimals = xpool ? (quoteInfo?.decimals ?? 18) : quoteSel === "USDG" ? 6 : 18;
  const quoteSym = xpool ? (quoteInfo?.symbol ?? "…") : quoteSel;
  const pickQuote = (q: "WETH" | "USDG") => {
    setQuoteSel(q);
    setAmtQuote(q === "USDG" ? "20" : "0.1"); // sensible default budget per quote
  };
  const [showSync, setShowSync] = useState(false); // stale-pool sync cost dialog open

  // The pair's existing Friar pools, populating the pool dropdown. Not fetched for a brought
  // pool (it pins its own). currency0/1 sort by address, so poolKeyFor gives the canonical pair.
  const pairCurrencies = token && !xpool ? poolKeyFor(token.address, quoteAddr).key : null;
  const existingPoolsQ = useQuery({
    queryKey: ["friarPools", pairCurrencies?.currency0, pairCurrencies?.currency1, tiers.length],
    queryFn: () => discoverFriarPools(pairCurrencies!.currency0, pairCurrencies!.currency1),
    enabled: !!pairCurrencies,
    staleTime: 15_000,
  });
  const existingPools: FriarPoolOption[] = existingPoolsQ.data ?? [];
  // reset the selection whenever the pair changes, so the default (deepest existing) reapplies
  useEffect(() => setPoolSel(""), [token?.address, quoteSel, xpool]);

  // Default selection: a prefilled pool (arrived from the Pools page) if it's among the
  // discovered pools, else the deepest, else "create new". Preferring the prefill in the
  // DEFAULT (not in poolSel state) survives the pair-change reset, which fires on first load.
  const prefillMatch = prefillPool
    ? existingPools.find((p) => poolId(p.key).toLowerCase() === prefillPool.toLowerCase())
    : undefined;
  const defaultSel = prefillMatch ? poolId(prefillMatch.key) : existingPools[0] ? poolId(existingPools[0].key) : NEW_POOL;
  const effPoolSel = poolSel || defaultSel;
  const creatingNew = effPoolSel === NEW_POOL;
  const poolChoice = useMemo(() => {
    if (xpool) return undefined; // brought pool → planOpen uses `explicit`
    if (effPoolSel === NEW_POOL)
      return {
        kind: "create" as const,
        feeHook: feeHookSel ? (feeHookSel as Address) : undefined,
        spacing: spacingInput.trim() ? Number(spacingInput) : undefined,
      };
    const p = existingPools.find((x) => poolId(x.key) === effPoolSel);
    return p ? { kind: "join" as const, key: p.key } : undefined; // undefined while pools load → legacy
  }, [xpool, effPoolSel, feeHookSel, spacingInput, existingPools]);

  const [plan, setPlan] = useState<OpenPlan | null>(null);

  // Funnel: fired once per token when a real, openable plan exists. This is the step that
  // separates "looked at the app" from "actually tried to LP" — the gap between it and
  // open_success is where the product loses people.
  const plannedFor = useRef<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [steps, setSteps] = useState<TxStep[] | null>(null);

  useEffect(() => {
    if (!plan || plan.error || !token) return;
    if (plannedFor.current === token.address) return;
    plannedFor.current = token.address;
    track("open_plan", { symbol: token.symbol });
  }, [plan, token]);

  const symQuery = useTokenSymbol(token?.address);

  // paste resolution: a token address, a v4 pool id, a v3 pair address, or a
  // Dexscreener URL wrapping any of those — one field, dispatched by what it is
  useEffect(() => {
    setToken(null);
    setTokenErr(null);
    setXpool(null);
    setQuoteInfo(null);
    setPasteNote(null);
    setShowSync(false); // new target → close any stale-pool dialog
    const target = parsePastedTarget(tokenAddr);
    if (!target) return;
    let stale = false;
    (async () => {
      try {
        if (target.kind === "pool") {
          const r = await resolvePastedPool(target.value);
          if (stale) return;
          if ("error" in r) return setTokenErr(r.error);
          if (r.verdict.level === "block") return setTokenErr(r.verdict.reasons[0]!);
          let t: TokenInfo, q: TokenInfo;
          try {
            [t, q] = await Promise.all([fetchToken(r.tokenAddress), fetchToken(r.quoteAddress)]);
          } catch {
            if (!stale) setTokenErr("couldn't read this pool's token metadata (non-standard ERC-20) — unsupported");
            return;
          }
          if (stale) return;
          if (r.verdict.level === "warn") setPasteNote(`⚠ ${r.verdict.reasons[0]!}`);
          if (r.railQuote) setQuoteSel(r.railQuote);
          setXpool(r);
          setQuoteInfo(q);
          setToken(t);
          return;
        }
        // 40-hex: an ERC-20, or a v2/v3 pair address (Dexscreener rows paste as pairs)
        try {
          const t = await fetchToken(target.value);
          if (!stale) setToken(t);
        } catch {
          const pair = await probePairAddress(target.value);
          if (stale) return;
          if (!pair) return setTokenErr("not an ERC-20 or a pool (symbol/decimals unreadable)");
          const rails: Array<{ sel: "WETH" | "USDG"; addr: string }> = [
            { sel: "USDG", addr: ADDRESSES.usdg.toLowerCase() },
            { sel: "WETH", addr: ADDRESSES.weth.toLowerCase() },
          ];
          const rail = rails.find((x) => x.addr === pair.token0.toLowerCase() || x.addr === pair.token1.toLowerCase());
          if (!rail) return setTokenErr("that pool isn't quoted in WETH or USDG — paste a v4 pool id instead");
          const tokenSide = rail.addr === pair.token0.toLowerCase() ? pair.token1 : pair.token0;
          const t = await fetchToken(tokenSide as Address);
          if (stale) return;
          setQuoteSel(rail.sel);
          setPasteNote("resolved a v2/v3 pool to its pair — Friar positions open on the v4 side");
          setToken(t);
        }
      } catch (e) {
        if (!stale) setTokenErr(humanErr(e));
      }
    })();
    return () => {
      stale = true;
    };
  }, [tokenAddr]);

  // live plan (debounced)
  useEffect(() => {
    if (!token) return setPlan(null);
    const input = {
      token,
      quote: quoteAddr,
      quoteDecimals,
      shape,
      depthBelowPct: Number(below) || 0,
      depthAbovePct: Number(above) || 0,
      mode,
      amountQuote: safeParse(amtQuote, quoteDecimals),
      amountBase: safeParse(amtBase, token.decimals),
      wingPct: Number(wingPct) || 0,
      simple: style === "simple",
      explicit: xpool ? { key: xpool.key, quoteIs0: xpool.quoteIs0 } : null,
      // pool-creation config (V2 create only; ignored when joining a live pool). base fee is
      // entered as a percent → pips (1% = 10,000 pips); blank inputs stay undefined so the
      // preset / default spacing applies.
      poolChoice,
    };
    setPlanning(true);
    const t = setTimeout(() => {
      planOpen(input)
        .then(setPlan)
        .catch((e) => {
          report("plan", e);
          setPlan(null);
          setTokenErr(humanErr(e));
        })
        .finally(() => setPlanning(false));
    }, 400);
    return () => clearTimeout(t);
  }, [token, quoteSel, shape, below, above, mode, amtQuote, amtBase, wingPct, style, xpool, poolChoice]);

  // LIVE re-plan: the range is centered on the pool's active tick, so if we only replan
  // on input changes the box stays pinned to whatever the price was when the form loaded.
  // A pump then leaves your whole range below the active bin. Silently re-plan every few
  // seconds (no "planning…" flash, no button disable) so the chart + bins track market.
  useEffect(() => {
    if (!token) return;
    const iv = setInterval(() => {
      planOpen({
        token,
        quote: quoteAddr,
        quoteDecimals,
        shape,
        depthBelowPct: Number(below) || 0,
        depthAbovePct: Number(above) || 0,
        mode,
        amountQuote: safeParse(amtQuote, quoteDecimals),
        amountBase: safeParse(amtBase, token.decimals),
        wingPct: Number(wingPct) || 0,
        simple: style === "simple",
        explicit: xpool ? { key: xpool.key, quoteIs0: xpool.quoteIs0 } : null,
        poolChoice,
      })
        .then(setPlan)
        .catch(() => {});
    }, 6000);
    return () => clearInterval(iv);
  }, [token, quoteSel, shape, below, above, mode, amtQuote, amtBase, wingPct, style, xpool, poolChoice]);

  // approvals
  const quoteAllowance = useReadContract({
    address: quoteAddr,
    abi: erc20Abi,
    functionName: "allowance",
    args: [address!, FPM],
    query: { enabled: !!address, refetchInterval: 4000 },
  });
  const baseAllowance = useReadContract({
    address: token?.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: [address!, FPM],
    query: { enabled: !!address && !!token && mode === "both", refetchInterval: 4000 },
  });
  // v3 router allowance for the ask-side wing pre-swap. Gated + max-approved so it's a
  // ONE-TIME grant per quote token — an exact-amount approval gets consumed by the swap,
  // forcing a re-approve every open AND breaking atomic-batch simulation (the swap sims
  // before the in-bundle approve applies → zero allowance → revert).
  const routerAllowance = useReadContract({
    address: quoteAddr,
    abi: erc20Abi,
    functionName: "allowance",
    args: [address!, ADDRESSES.v3SwapRouter02 as Address],
    query: { enabled: !!address && !!plan?.routerSwap, refetchInterval: 4000 },
  });

  // warn-level safety flags (mintable/pausable/blacklist…): not blocked, but shown —
  // the block level never gets here (planOpen refuses with plan.error instead)
  const safety = useQuery({
    queryKey: ["safety", token?.address.toLowerCase()],
    enabled: !!token,
    staleTime: Infinity,
    queryFn: () => fetchTokenSafety(token!.address),
  });

  const approve = useWriteContract();
  const approveReceipt = useWaitForTransactionReceipt({ hash: approve.data });
  const open = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: open.data });

  // a standalone approval just landed → refresh allowances so the button advances now
  useEffect(() => {
    if (approveReceipt.isSuccess) {
      void routerAllowance.refetch();
      void quoteAllowance.refetch();
      void baseAllowance.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approveReceipt.isSuccess]);

  // EIP-5792 atomic batching (7702): approvals + open in ONE wallet prompt where the
  // wallet supports it on this chain; sequential prompts otherwise.
  const caps = useCapabilities({ account: address, query: { enabled: !!address } });
  const capsMap = (caps.data ?? {}) as Record<string | number, { atomic?: { status?: string }; atomicBatch?: { supported?: boolean } }>;
  const chainCaps = capsMap[robinhoodChain.id] ?? capsMap[`0x${robinhoodChain.id.toString(16)}`];
  const atomicOk =
    chainCaps?.atomic?.status === "supported" ||
    chainCaps?.atomic?.status === "ready" ||
    chainCaps?.atomicBatch?.supported === true;
  const batch = useSendCalls();
  const batchStatus = useCallsStatus({
    id: batch.data?.id as string,
    query: {
      enabled: !!batch.data?.id,
      refetchInterval: (q) => (q.state.data?.status === "success" ? false : 1500),
    },
  });
  const batchDone = batchStatus.data?.status === "success";
  useEffect(() => {
    if (batch.error) report("open — atomic batch", batch.error);
  }, [batch.error]);

  // The position id straight from the tx receipt logs — instant, no RPC (the atomic-batch
  // receipt carries these), so it can't be defeated by indexer rate limits.
  const openedIdFromLogs = (logs?: readonly Log[]): number | undefined => {
    if (!logs?.length) return undefined;
    try {
      const ev = parseEventLogs({ abi: friarPositionManagerAbi, logs: logs as Log[], eventName: "PositionOpened" });
      const pid = (ev[0] as { args?: { positionId?: bigint } } | undefined)?.args?.positionId;
      return pid != null ? Number(pid) : undefined;
    } catch {
      return undefined;
    }
  };

  // Eager ingest, RETRIED — a just-mined tx can briefly race RPC rate limits on the indexer,
  // and a single failed call is exactly what dumped us on an empty list before.
  const ingestWithRetry = async (hash: string): Promise<number | undefined> => {
    for (let i = 0; i < 4; i++) {
      try {
        const r = await fetch(`${INDEXER_BASE}/ingest-tx?hash=${hash}`);
        const j = (await r.json()) as { positions?: number[] };
        if (j.positions?.[0] != null) return j.positions[0];
      } catch {
        /* transient — retry */
      }
      await new Promise((res) => setTimeout(res, 700));
    }
    return undefined;
  };

  // Route to the freshly-opened position's detail page (which polls until it indexes). Prefer
  // the id from receipt logs; else resolve it via the retried ingest. Always kicks the ingest
  // so the detail page loads fast. Falls back to the list only if no id resolves at all.
  const finishOpen = async (hash?: `0x${string}`, logs?: readonly Log[]) => {
    track("open_success"); // the bottom of the funnel — every open path lands here
    const idFromLogs = openedIdFromLogs(logs);
    if (idFromLogs !== undefined) {
      if (hash) void ingestWithRetry(hash); // background: get it into D1 for the detail page
      onDone(idFromLogs);
      return;
    }
    onDone(hash ? await ingestWithRetry(hash) : undefined);
  };

  useEffect(() => {
    if (!(receipt.isSuccess || batchDone)) return;
    const bs = batchStatus.data as { receipts?: Array<{ transactionHash?: `0x${string}`; logs?: Log[] }> } | undefined;
    const hash = open.data ?? bs?.receipts?.at(-1)?.transactionHash;
    const logs = bs?.receipts?.flatMap((r) => r.logs ?? []);
    void finishOpen(hash, logs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess, batchDone]);

  const quoteBalance = useReadContract({
    address: quoteAddr,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address!],
    query: { enabled: !!address, refetchInterval: 5000 },
  });
  const baseBalance = useReadContract({
    address: token?.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address!],
    query: { enabled: !!address && !!token && mode === "both", refetchInterval: 5000 },
  });
  // Native ETH, so a WETH shortfall can be closed in-flow instead of dead-ending.
  const native = useBalance({ address, query: { enabled: !!address, refetchInterval: 5000 } });
  const quoteIsWeth = quoteAddr.toLowerCase() === (ADDRESSES.weth as string).toLowerCase();
  const quoteNeeded = safeParse(amtQuote, quoteDecimals);
  const quoteBal = quoteBalance.data;
  const baseBal = baseBalance.data;
  const nativeBal = native.data?.value;
  // Can this wallet pay for the plan? Decided in ../preflight (pure + tested) — an
  // unanswered balance read is UNKNOWN there, never sufficient, so a throttled RPC can no
  // longer green-light an open. The guards below only add "is there a plan and a wallet
  // to judge"; the money logic itself lives in one place.
  const pf = preflight({
    quoteBal,
    baseBal,
    nativeBal,
    quoteNeeded,
    baseNeeded: token ? safeParse(amtBase, token.decimals) : 0n,
    quoteIsWeth,
    needsBase: mode === "both" && !!token,
    gasReserve: GAS_RESERVE,
  });
  const wrapAmount = pf.wrapAmount;

  const planReady = plan !== null && plan.error === null;
  const insufficientQuote = planReady && pf.insufficientQuote;
  const insufficientBase = planReady && pf.insufficientBase;
  // Gas is paid in native ETH here and nothing else in this flow looked for it: a wallet
  // funded only with WETH could walk every step and still meet a greyed-out Confirm in the
  // wallet itself, with no explanation that belonged to us.
  const noGas = planReady && !!address && pf.noGas;
  const lowGas = planReady && pf.lowGas;
  const balancesUnknown = planReady && !!address && pf.unknown;

  // Approvals are granted at EXACTLY the on-chain pay cap (needsQuote/needsBase already
  // carry the 101/100 headroom that becomes maxPay0/maxPay1), never a multiple of it.
  // A residual allowance is live exit-path exposure, not a convenience: the manager's
  // exit verbs settle a negative delta by transferFrom-ing the owner, so whatever is
  // left approved after an open is what a hostile zap venue could pull. Exact-cap
  // approval leaves at most the unspent ~1% instead of ~100x the position.
  const needQuoteApproval = plan !== null && plan.needsQuote > 0n && (quoteAllowance.data ?? 0n) < plan.needsQuote;
  const needBaseApproval = plan !== null && mode === "both" && plan.needsBase > 0n && (baseAllowance.data ?? 0n) < plan.needsBase;
  const needRouterApproval = plan?.routerSwap != null && (routerAllowance.data ?? 0n) < plan.routerSwap.amountIn;
  // the plan slides a stale/empty pool to market before minting; gate it behind a cost dialog
  const willSync = plan?.willSync === true;
  const runOpen = () => (atomicOk ? submitBatch() : setSteps(buildSteps()));

  const openCalldata = (): Hex | null => {
    if (!plan || plan.error) return null;
    const call = buildOpenCall(plan);
    // buildOpenCall guarantees the arg tuple per verb; viem can't infer a tuple from a
    // union functionName, so cast at this boundary (the standard dynamic-dispatch escape).
    return encodeFunctionData({ abi: friarPositionManagerAbi, functionName: call.functionName, args: call.args as never });
  };

  const submitBatch = () => {
    const data = openCalldata();
    if (!data || !plan || !token || !address) return;
    const calls: Array<{ to: Address; data: Hex; value?: bigint }> = [];
    if (wrapAmount > 0n)
      calls.push({ to: quoteAddr, data: encodeFunctionData({ abi: wethAbi, functionName: "deposit" }), value: wrapAmount });
    if (plan.routerSwap) {
      const rs = plan.routerSwap;
      if (needRouterApproval)
        calls.push({ to: quoteAddr, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ADDRESSES.v3SwapRouter02 as Address, MAX_UINT256] }) });
      calls.push({
        to: ADDRESSES.v3SwapRouter02 as Address,
        data:
          rs.kind === "v3"
            ? encodeFunctionData({
                abi: v3RouterAbi,
                functionName: "exactInputSingle",
                args: [{ tokenIn: quoteAddr, tokenOut: token.address, fee: rs.fee, recipient: address, amountIn: rs.amountIn, amountOutMinimum: rs.minOut, sqrtPriceLimitX96: 0n }],
              })
            : encodeFunctionData({
                abi: v2RouterAbi,
                functionName: "swapExactTokensForTokens",
                args: [rs.amountIn, rs.minOut, [quoteAddr, token.address], address],
              }),
      });
      calls.push({ to: token.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [FPM, plan.needsBase] }) });
    }
    if (needQuoteApproval)
      calls.push({ to: quoteAddr, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [FPM, plan.needsQuote] }) });
    if (mode === "both" && needBaseApproval)
      calls.push({ to: token.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [FPM, plan.needsBase] }) });
    calls.push({ to: FPM, data });
    batch.sendCalls({ calls });
  };

  /** Guided sequential path (non-batching wallets): one narrated step per transaction. */
  const buildSteps = (): TxStep[] => {
    const s: TxStep[] = [];
    if (!plan || !token || !address) return s;
    if (wrapAmount > 0n)
      s.push({
        label: `wrap ${fmtAmount(wrapAmount, 18)} ETH → WETH`,
        detail: "WETH is what the pool is quoted in; this is a 1:1 deposit you can unwrap any time",
        run: () => approve.writeContractAsync({ address: quoteAddr, abi: wethAbi, functionName: "deposit", value: wrapAmount }),
      });
    if (plan.routerSwap) {
      const rs = plan.routerSwap;
      if (needRouterApproval)
        s.push({ label: `approve ${quoteSym} → swap router (one-time)`, detail: "unlimited allowance so future zaps skip this", run: () => approve.writeContractAsync({ address: quoteAddr, abi: erc20Abi, functionName: "approve", args: [ADDRESSES.v3SwapRouter02 as Address, MAX_UINT256] }) });
      s.push({
        label: "buy the ask-side wing",
        detail: `swap ${fmtAmount(rs.amountIn, quoteDecimals)} ${quoteSym} → ${token.symbol} on the ${rs.kind} pool (min-out guarded)`,
        run: () =>
          rs.kind === "v3"
            ? approve.writeContractAsync({ address: ADDRESSES.v3SwapRouter02 as Address, abi: v3RouterAbi, functionName: "exactInputSingle", args: [{ tokenIn: quoteAddr, tokenOut: token.address, fee: rs.fee, recipient: address, amountIn: rs.amountIn, amountOutMinimum: rs.minOut, sqrtPriceLimitX96: 0n }] })
            : approve.writeContractAsync({ address: ADDRESSES.v3SwapRouter02 as Address, abi: v2RouterAbi, functionName: "swapExactTokensForTokens", args: [rs.amountIn, rs.minOut, [quoteAddr, token.address], address] }),
      });
      s.push({ label: `approve ${token.symbol}`, detail: "allow the manager to place the wing into ask bins", run: () => approve.writeContractAsync({ address: token.address, abi: erc20Abi, functionName: "approve", args: [FPM, plan.needsBase] }) });
    }
    if (needQuoteApproval)
      s.push({ label: `approve ${quoteSym}`, detail: `capped at exactly ${fmtAmount(plan.needsQuote, quoteDecimals)} ${quoteSym}: your budget plus 1% rounding headroom, not an unlimited allowance`, run: () => approve.writeContractAsync({ address: quoteAddr, abi: erc20Abi, functionName: "approve", args: [FPM, plan.needsQuote] }) });
    if (mode === "both" && needBaseApproval)
      s.push({ label: `approve ${token.symbol}`, detail: `capped at exactly ${fmtAmount(plan.needsBase, token.decimals)} ${token.symbol}: your deposit plus 1% rounding headroom, not an unlimited allowance`, run: () => approve.writeContractAsync({ address: token.address, abi: erc20Abi, functionName: "approve", args: [FPM, plan.needsBase] }) });
    s.push({
      label: plan.pool.live ? "open position" : "create pool + open",
      detail: "mint all bins atomically — pay caps enforced on-chain",
      run: () => {
        const call = buildOpenCall(plan);
        return approve.writeContractAsync({ address: FPM, abi: friarPositionManagerAbi, functionName: call.functionName, args: call.args as never });
      },
    });
    return s;
  };

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    setBelow(p.below);
    setAbove(p.above);
    if (p.shape) setShape(p.shape);
    if (p.wing) setWingPct(p.wing);
  };

  const sym = token?.symbol ?? symQuery.data?.symbol ?? "token";
  // anchor the chart at the LIVE/market price the bins are placed around — not a stale
  // pool's frozen tick (e.g. a ghost pool stuck at MAX_TICK reads as a nonsense price).
  const chartTick = plan && !plan.error ? plan.anchorTick : null;
  const chartSqrt = plan && !plan.error ? plan.anchorSqrt : null;
  const bidCount = plan?.bins.filter((b) => b.side === "bid").length ?? 0;
  const askCount = plan?.bins.filter((b) => b.side === "ask").length ?? 0;
  const busy = batch.isPending || (!!batch.data?.id && !batchDone) || planning;

  return (
    <>
      <button className="crumb" onClick={() => (onBack ? onBack() : onDone())}>
        ← {backLabel}
      </button>

      <div className="create">
        {/* chart card */}
        <div className="card-box">
          <div className="binchart-head" style={{ alignItems: "center" }}>
            <span>
              <b style={{ fontSize: 16, color: "var(--text)" }}>{sym}</b> <span className="dim">/ {quoteSym}</span>
              {plan?.pool.live && (
                <span className="gold" style={{ marginLeft: 10 }}>
                  fee {(plan.pool.lpFee / 10_000).toFixed(2)}% · {plan.key.fee === DYNAMIC_FEE_FLAG ? "dynamic" : "static"}
                </span>
              )}
            </span>
            <div className="tf-chips">
              {["5m", "15m", "1h", "4h"].map((t) => (
                <button key={t} className={`tf-chip ${tf === t ? "active" : ""}`} onClick={() => setTf(t)}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          {/* live price chart (GMGN kline, covers Robinhood Chain) until native candles ship */}
          {token ? (
            <iframe
              title="price chart"
              src={`https://www.gmgn.cc/kline/robinhood/${token.address}?theme=dark&interval=${GMGN_INTERVAL[tf] ?? "60"}`}
              loading="lazy"
              style={{ width: "100%", height: 520, border: "none", borderRadius: 8, background: "var(--bg)" }}
            />
          ) : (
            <div className="loading" style={{ height: 520, display: "flex", alignItems: "center", justifyContent: "center" }}>
              enter a token address to load the chart
            </div>
          )}
          <div className="binchart-head" style={{ marginTop: 10, marginBottom: 0 }}>
            <span className="faint">charts by GMGN · TradingView pending</span>
          </div>
        </div>

        {/* form column */}
        <div className="form-panel">
          <div className="card-box" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="field">
              <span className="field-label">token / pool</span>
              <input
                className="input"
                value={tokenAddr}
                onChange={(e) => setTokenAddr(e.target.value.trim())}
                placeholder="token address, v4 pool id, or Dexscreener link"
                spellCheck={false}
              />
            </div>
            {token && xpool && (
              <div className="mono dim" style={{ fontSize: 11 }}>
                {token.symbol}/{quoteSym} ·{" "}
                {xpool.key.fee === DYNAMIC_FEE_FLAG ? "dynamic fee" : `fee ${(xpool.key.fee / 10_000).toFixed(2)}%`} · spacing{" "}
                {xpool.key.tickSpacing} ·{" "}
                {xpool.key.hooks.toLowerCase() === ADDRESSES.friarStandard.toLowerCase() ||
                xpool.key.hooks.toLowerCase() === ADDRESSES.friarCalm.toLowerCase() ? (
                  <span className="gold">Friar hook</span>
                ) : xpool.verdict.flags.length === 0 ? (
                  <span className="green">no hook</span>
                ) : (
                  <span className={xpool.verdict.level === "warn" ? "warn" : "green"}>hooked pool · exit-safe</span>
                )}
              </div>
            )}
            {token && !xpool && (
              <div className="mono dim" style={{ fontSize: 11 }}>
                {token.symbol} · {token.decimals} decimals ·{" "}
                {plan?.pool.live ? (
                  <span className="green">Friar pool live at tick {plan.pool.tick}</span>
                ) : plan ? (
                  <span className="warn">no Friar pool yet — this open will CREATE it at market price</span>
                ) : (
                  "resolving pool…"
                )}
              </div>
            )}
            {tokenErr && <div className="mono red" style={{ fontSize: 11 }}>{tokenErr}</div>}
            {pasteNote && <div className="mono warn" style={{ fontSize: 11 }}>{pasteNote}</div>}
            {safety.data?.level === "warn" && (
              <div className="mono warn" style={{ fontSize: 11 }}>
                ⚠ safety flags: {prettyRiskFlags(safety.data.flags).join(", ")} — not blocked, but know what you're LPing
              </div>
            )}

            {/* The board's numbers for whatever was pasted, so the decision doesn't have
                to be made blind on a token the board never listed. */}
            {token && <TokenMarket address={token.address} />}

            {!xpool && (
              <div>
                <div className="field-label" style={{ marginBottom: 6 }}>quote</div>
                <div className="segmented">
                  {(["WETH", "USDG"] as const).map((q) => (
                    <button key={q} className={quoteSel === q ? "active" : ""} onClick={() => pickQuote(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* horizontal liquidity preview: liquidity on Y, price on X — the live shape
                the inputs below will mint. Placeholder until the real chartview lands. */}
            {plan && !plan.error && token && (
              <LiquidityPreview
                bins={plan.bins}
                quoteIs0={plan.quoteIs0}
                currentTick={chartTick}
                sqrtPrice={chartSqrt}
                tokenDecimals={token.decimals}
                quoteDecimals={quoteDecimals}
                quoteSym={quoteSym}
                simple={style === "simple"}
              />
            )}

            <div>
              <div className="field-label" style={{ marginBottom: 6 }}>liquidity</div>
              <div className="segmented">
                <button className={style === "shaped" ? "active" : ""} onClick={() => setStyle("shaped")}>
                  Shaped
                </button>
                <button className={style === "simple" ? "active" : ""} onClick={() => setStyle("simple")}>
                  Simple
                </button>
              </div>
            </div>

            {style === "shaped" && (
              <div>
                <div className="field-label" style={{ marginBottom: 6 }}>shape</div>
                <div className="segmented">
                  {SHAPES.map((s) => (
                    <button key={s.v} className={shape === s.v ? "active" : ""} onClick={() => setShape(s.v)}>
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="field-row">
              <div className="field">
                <span className="field-label">% below</span>
                <input className="input" value={below} onChange={(e) => setBelow(e.target.value)} inputMode="decimal" />
              </div>
              <div className="field">
                <span className="field-label">% above</span>
                <input className="input" value={above} onChange={(e) => setAbove(e.target.value)} inputMode="decimal" />
              </div>
            </div>

            <div className="pills">
              {PRESETS.map((p) => {
                const active = p.below === below && p.above === above && (!p.shape || p.shape === shape);
                return (
                  <button key={p.label} className={`pill ${active ? "active" : ""}`} onClick={() => applyPreset(p)}>
                    {p.label}
                  </button>
                );
              })}
            </div>

            {/* Pool selection: pick an existing Friar pool from the list (default = deepest),
                or the last option "Create a new pool", which reveals the fee-tier + bin-width
                controls. Existing pools are shown outright so nobody discovers them by guessing
                a combo. Shown once the tier set is deployed; a brought pool pins its own. */}
            {!xpool && tiers.length > 0 && (
              <div>
                <div className="field-label" style={{ marginBottom: 6 }}>pool</div>
                <select className="input" value={effPoolSel} onChange={(e) => setPoolSel(e.target.value)}>
                  {existingPools.map((p) => {
                    const id = poolId(p.key);
                    const binPct = FRIAR_V2_SPACINGS.find((s) => s.value === p.spacing)?.binPct ?? `${(p.spacing / 100).toFixed(1)}%`;
                    return (
                      <option key={id} value={id}>
                        {p.feePct != null ? `${p.feePct}% base` : "legacy"} · {binPct} bins
                      </option>
                    );
                  })}
                  <option value={NEW_POOL}>+ Create a new pool</option>
                </select>

                {creatingNew && (
                  <div className="field-row" style={{ marginTop: 10 }}>
                    <div className="field">
                      <span className="field-label">fee tier</span>
                      <select className="input" value={feeHookSel} onChange={(e) => setFeeHookSel(e.target.value)}>
                        {tiers.map((t) => (
                          <option key={t.hook} value={t.hook!}>
                            {t.pct}% base fee
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <span className="field-label">bin width</span>
                      <select
                        className="input"
                        value={spacingInput || String(defaultSpacingFor(quoteAddr))}
                        onChange={(e) => setSpacingInput(e.target.value)}
                      >
                        {FRIAR_V2_SPACINGS.map((s) => (
                          <option key={s.value} value={s.value}>
                            {s.binPct} bins · spacing {s.value}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
                <div style={{ marginTop: 6, fontSize: 12, opacity: 0.65 }}>
                  {creatingNew
                    ? "New pool — you'll be the first LP. Fee tier is the base fee; each fee tier and bin width is its own pool."
                    : "Joining an existing pool. Pick “Create a new pool” to open a different fee tier or width."}
                </div>
              </div>
            )}

            <div>
              <div className="field-label" style={{ marginBottom: 6 }}>deposit</div>
              <div className="toggle">
                <button className={mode === "zap" ? "active" : ""} onClick={() => setMode("zap")}>
                  Zap from {quoteSym}
                </button>
                <button className={mode === "both" ? "active" : ""} onClick={() => setMode("both")}>
                  Both tokens
                </button>
              </div>
            </div>

            <div className="field-row">
              <div className="field" style={{ flex: 1.6 }}>
                <span className="field-label">{quoteSym} amount</span>
                <input className="input" value={amtQuote} onChange={(e) => setAmtQuote(e.target.value)} inputMode="decimal" />
              </div>
              {mode === "both" ? (
                <div className="field">
                  <span className="field-label">{sym} amount</span>
                  <input className="input" value={amtBase} onChange={(e) => setAmtBase(e.target.value)} inputMode="decimal" />
                </div>
              ) : style === "simple" ? (
                <div className="field">
                  <span className="field-label">{sym} side</span>
                  <div className="mono dim" style={{ fontSize: 11, paddingTop: 9 }}>auto — sized to your range</div>
                </div>
              ) : (
                <div className="field">
                  <span className="field-label">wing % → asks</span>
                  <input className="input" value={wingPct} onChange={(e) => setWingPct(e.target.value)} inputMode="decimal" />
                </div>
              )}
            </div>

            {/* balance pre-flight (meaningless without a wallet) */}
            {plan && !plan.error && !!address && (
              <>
                <div className={`preflight ${insufficientQuote ? "bad" : quoteBal === undefined ? "warn" : "ok"}`}>
                  {quoteBal === undefined
                    ? `couldn't read your ${quoteSym} balance, retrying…`
                    : insufficientQuote
                      ? `you hold ${fmtAmount(quoteBal, quoteDecimals)} ${quoteSym} but the plan needs ${amtQuote}${quoteSel === "WETH" ? ", and not enough ETH to wrap" : ""}`
                      : wrapAmount > 0n
                        ? `${quoteSym} balance ${fmtAmount(quoteBal, quoteDecimals)}, will wrap ${fmtAmount(wrapAmount, 18)} ETH first ✓`
                        : `${quoteSym} balance ${fmtAmount(quoteBal, quoteDecimals)} ✓`}
                </div>
                {mode === "both" && (
                  <div className={`preflight ${insufficientBase ? "bad" : baseBal === undefined ? "warn" : "ok"}`}>
                    {baseBal === undefined
                      ? `couldn't read your ${sym} balance, retrying…`
                      : insufficientBase
                        ? `you hold ${fmtQuote(baseBal.toString())} but the plan needs ${amtBase} ${sym}: buy the difference or switch to zap`
                        : `${sym} balance ✓`}
                  </div>
                )}
                {/* gas: ETH on 4663, which a wallet arriving with only WETH will not have */}
                <div className={`preflight ${noGas ? "bad" : nativeBal === undefined || lowGas ? "warn" : "ok"}`}>
                  {nativeBal === undefined
                    ? "couldn't read your ETH balance, retrying…"
                    : noGas
                      ? "no ETH on Robinhood Chain to pay gas: bridge or send a little ETH to this wallet on chain 4663 first"
                      : lowGas
                        ? `gas ${fmtAmount(nativeBal, 18)} ETH, thin but enough`
                        : `gas ${fmtAmount(nativeBal, 18)} ETH ✓`}
                </div>
              </>
            )}
          </div>

          {/* preview */}
          {plan?.error && <div className="mono red" style={{ fontSize: 12 }}>{plan.error}</div>}
          {plan && !plan.error && (
            <div className="card-box preview-rows">
              <div className="preview-row">
                <span className="k">bins</span>
                <span>{style === "simple" ? "single range (1 bin)" : `${bidCount} bid / ${askCount} ask`}</span>
              </div>
              <div className="preview-row">
                <span className="k">pays at most</span>
                <span>
                  {fmtAmount(plan.quoteIs0 ? plan.maxPay0 : plan.maxPay1, quoteDecimals)} {quoteSym}
                  {mode === "both" && ` + ${amtBase} ${sym}`}
                </span>
              </div>
              <div className="preview-row">
                <span className="k">{plan.swapIn.enabled || plan.routerSwap ? "wing swap in-tx" : "swap"}</span>
                <span>
                  {plan.swapIn.enabled
                    ? `${fmtAmount(plan.swapIn.amountIn, quoteDecimals)} ${quoteSym} · min-out guarded`
                    : plan.routerSwap
                      ? `${fmtAmount(plan.routerSwap.amountIn, quoteDecimals)} ${quoteSym} via ${plan.routerSwap.kind} · min-out guarded`
                      : "none — both tokens supplied as-is"}
                </span>
              </div>
              <div className="preview-row">
                <span className="k">{plan.key.fee === DYNAMIC_FEE_FLAG ? "dynamic fee now" : "pool fee"}</span>
                <span className="gold">{plan.pool.live ? `${(plan.pool.lpFee / 10_000).toFixed(2)}%${plan.key.fee === DYNAMIC_FEE_FLAG ? " ▲" : ""}` : "set at creation"}</span>
              </div>
              <div className="disclose">
                {perfFeeCopy(currentManager(), style === "simple")}{" "}
                <a href={DOCS_OPENING} target="_blank" rel="noreferrer" onClick={() => track("docs_click")}>
                  what these controls do ↗
                </a>
              </div>
            </div>
          )}

          {/* brought pool sitting off the market reference: informational only — we never
              sync a pool that isn't ours (and one with depth wouldn't move anyway) */}
          {plan && !plan.error && !willSync && xpool && plan.drift && plan.drift.pricePct > 8 && (
            <div className="preflight bad" style={{ fontSize: 12 }}>
              ⚠ this pool trades <b>{fmtDrift(plan.drift.pricePct)} off the market reference</b> — your range anchors to the
              pool's own price; make sure that's the price you believe.
            </div>
          )}

          {/* stale-pool note: the open will first sync it to market (details in the dialog) */}
          {plan && !plan.error && willSync && (
            <div className="preflight bad" style={{ fontSize: 12 }}>
              ⚠ This {quoteSym} pool is <b>{fmtDrift(plan.drift!.pricePct)} off the live market</b> — the open will slide it to
              market first, then place your position there. You'll confirm the cost next.
            </div>
          )}

          {/* submit — open to everyone since 2026-07-25 (the invite gate stood here) */}
          {plan && !plan.error && (
            <>
              {/* Blocked states come FIRST, gas before funds: a wallet with no ETH can't send
                  the approve either way, and bridging in is what unblocks both. Reaching a
                  wallet prompt that can only be rejected is the worst version of this screen. */}
              {noGas ? (
                <button className="btn btn-gold btn-lg btn-block" disabled>
                  Open position: no ETH for gas
                </button>
              ) : insufficientQuote || insufficientBase ? (
                <button className="btn btn-gold btn-lg btn-block" disabled>
                  Open position: insufficient {insufficientBase ? sym : quoteSym}
                </button>
              ) : balancesUnknown ? (
                <button className="btn btn-gold btn-lg btn-block" disabled>
                  Checking your balances…
                </button>
              ) : needRouterApproval ? (
                // one-time, standalone: commit the router allowance BEFORE the open so the
                // wing swap never simulates against a not-yet-applied in-bundle approve.
                <button
                  className="btn btn-gold btn-lg btn-block"
                  disabled={approve.isPending || approveReceipt.isLoading}
                  onClick={() =>
                    approve.writeContract({ address: quoteAddr, abi: erc20Abi, functionName: "approve", args: [ADDRESSES.v3SwapRouter02 as Address, MAX_UINT256] })
                  }
                >
                  {approve.isPending ? "confirm in wallet…" : approveReceipt.isLoading ? "approving…" : `Approve ${quoteSym} for zaps — one-time`}
                </button>
              ) : willSync ? (
                <button className="btn btn-gold btn-lg btn-block" onClick={() => setShowSync(true)} disabled={busy}>
                  Sync {quoteSym} pool to market &amp; open…
                </button>
              ) : atomicOk ? (
                <button className="btn btn-gold btn-lg btn-block" onClick={submitBatch} disabled={busy}>
                  {batch.isPending ? "confirm in wallet…" : batch.data?.id && !batchDone ? "opening…" : plan.pool.live ? "Open position" : "Create pool + open"}
                </button>
              ) : (
                <button className="btn btn-gold btn-lg btn-block" onClick={() => setSteps(buildSteps())} disabled={planning}>
                  {plan.pool.live ? "Open position" : "Create pool + open"}
                </button>
              )}
              <div className="submit-note">
                {needRouterApproval
                  ? `one-time: approve ${quoteSym} for the zap router — every future zap skips it`
                  : atomicOk
                    ? "wallet supports atomic batching (EIP-5792) — approvals bundled"
                    : "multiple transactions — a guided stepper walks you through each"}
              </div>
              {batch.error && <div className="mono red" style={{ fontSize: 11 }}>{humanErr(batch.error)}</div>}
              {batchDone && <div className="mono green" style={{ fontSize: 12 }}>opened ✓ — returning to positions…</div>}
            </>
          )}
        </div>
      </div>

      {steps && (
        <TxStepper
          steps={steps}
          onAllDone={(hash) => {
            setSteps(null);
            void finishOpen(hash);
          }}
          onClose={() => setSteps(null)}
        />
      )}

      {/* stale-pool sync cost dialog: state what happens + what it costs, require OK */}
      {showSync && plan?.drift && (
        <div className="overlay">
          <div className="modal">
            <div className="modal-title">Sync {quoteSym} pool to market</div>
            <div className="modal-sub">this pool is {fmtDrift(plan.drift.pricePct)} off the live price</div>
            <div style={{ fontSize: 13, lineHeight: 1.55, margin: "12px 0" }}>
              The {sym}/{quoteSym} pool is empty and stuck at a stale price. This open will first
              slide it to the <b>live market price</b>, then place your position there — in one
              transaction.
              <div className="disclose" style={{ marginTop: 12 }}>
                Cost to sync: <b>gas only</b> (~a few cents). An empty pool has no liquidity to
                trade through, so no tokens are spent moving the price — it just slides to market.
                Your position then opens normally with your {quoteSym} budget.
              </div>
            </div>
            <div className="modal-actions">
              <button
                className="btn btn-gold"
                onClick={() => {
                  setShowSync(false);
                  runOpen();
                }}
              >
                OK — sync &amp; open
              </button>
              <button className="btn" onClick={() => setShowSync(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Horizontal liquidity histogram (liquidity Y, price X — cheap left) of the planned
 * bins, with the red market marker and %/price edge labels. Sits above the shape
 * controls so the distribution redraws as you tune shape / % / wing. */
function LiquidityPreview({
  bins,
  quoteIs0,
  currentTick,
  sqrtPrice,
  tokenDecimals,
  quoteDecimals,
  quoteSym,
  simple = false,
}: {
  bins: ChartBin[];
  quoteIs0: boolean;
  currentTick: number | null;
  sqrtPrice: bigint | null;
  tokenDecimals: number;
  quoteDecimals: number;
  quoteSym: string;
  simple?: boolean;
}) {
  const model = binModel(bins, quoteIs0, sqrtPrice, currentTick, { token: tokenDecimals, quote: quoteDecimals });
  if (!model) return null;
  // simple mode: one range, one color — the gold, not the composition palette
  if (simple) model.bars = model.bars.map((b) => ({ ...b, kind: "quote" as const }));
  const edge = (pct: string, price: string | null) =>
    price ? (
      <>
        {pct} <span className="axis-price">{price}</span>
      </>
    ) : (
      pct
    );
  return (
    <div>
      <div className="binchart-head" style={{ marginBottom: 6 }}>
        <span className="chart-legend">
          {simple ? (
            <>your range</>
          ) : (
            <>
              your liquidity — <span className="sq sw-quote" />{quoteSym} bids · <span className="sq sw-active" />active ·{" "}
              <span className="sq sw-token" />token asks
            </>
          )}
        </span>
      </div>
      <BinBars model={model} height={96} />
      <div className="card-axis" style={{ marginTop: 6 }}>
        <span>{edge(model.leftPct, model.leftPrice)}</span>
        {model.markFrac !== null && (
          <span className="red">▼ {model.markPrice ? `${model.markPrice} ${quoteSym}` : "market"}</span>
        )}
        <span>{edge(model.rightPct, model.rightPrice)}</span>
      </div>
    </div>
  );
}

export interface TxStep {
  label: string;
  detail: string;
  run: () => Promise<`0x${string}`>;
}

type StepStatus = "todo" | "wallet" | "mining" | "done" | "failed";
const startedRuns = new WeakSet<TxStep[]>();
const STEP_GLYPH: Record<StepStatus, string> = { todo: "○", wallet: "◐", mining: "◑", done: "●", failed: "✕" };

/** Guided sequential execution (frame 1f): narrates each transaction, auto-submits
 * the next as the previous confirms, retries from the failed step. Failures show the
 * humanized one-liner; the verbatim error ships to /client-log with the step's tx hash. */
export function TxStepper({
  steps,
  onAllDone,
  onClose,
  title = "Opening position",
}: {
  steps: TxStep[];
  onAllDone: (lastHash?: `0x${string}`) => void;
  onClose: () => void;
  title?: string;
}) {
  const [statuses, setStatuses] = useState<StepStatus[]>(steps.map(() => "todo"));
  const [err, setErr] = useState<string | null>(null);
  const running = useRef(false);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const runFrom = async (start: number) => {
    if (running.current) return;
    running.current = true;
    setErr(null);
    let lastHash: `0x${string}` | undefined;
    for (let i = start; i < steps.length; i++) {
      if (cancelled.current) {
        running.current = false;
        return;
      }
      setStatuses((s) => s.map((v, j) => (j === i ? "wallet" : v)));
      let hash: `0x${string}` | undefined;
      try {
        hash = await steps[i]!.run();
        lastHash = hash;
        setStatuses((s) => s.map((v, j) => (j === i ? "mining" : v)));
        await publicClient.waitForTransactionReceipt({ hash });
        setStatuses((s) => s.map((v, j) => (j === i ? "done" : v)));
      } catch (e) {
        setStatuses((s) => s.map((v, j) => (j === i ? "failed" : v)));
        // A receipt-wait timeout is ambiguous on its own — slow, or never broadcast at all.
        // Resolve it before reporting so the operator's action name and the user's advice
        // both say which, instead of "timed out" three times in a row (see txprobe.ts).
        const verdict = await explainTimeout(e, hash);
        report(`${title} — ${steps[i]!.label}${verdict?.action ? ` [${verdict.action}]` : ""}`, e, hash ? { txHash: hash } : {});
        setErr(verdict?.message ?? humanErr(e));
        running.current = false;
        return;
      }
    }
    running.current = false;
    onAllDone(lastHash); // final step = the open tx; hand its hash to the finisher
  };

  useEffect(() => {
    if (startedRuns.has(steps)) return;
    startedRuns.add(steps);
    void runFrom(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const failedAt = statuses.indexOf("failed");
  const allDone = statuses.every((s) => s === "done");

  return (
    <div className="overlay">
      <div className="modal">
        <div className="modal-title">{title}</div>
        <div className="modal-sub">
          {steps.length} transaction{steps.length === 1 ? "" : "s"} — auto-advances as each mines
        </div>
        <ul className="steps">
          {steps.map((s, i) => (
            <li key={i} className={`step step-${statuses[i]} ${statuses[i] === "todo" ? "todo" : ""}`}>
              <span className="step-glyph">{STEP_GLYPH[statuses[i]!]}</span>
              <span>
                <span className="step-label">{s.label}</span>
                <span className="dim"> — {s.detail}</span>
                {statuses[i] === "wallet" && <span className="dim"> (confirm in wallet…)</span>}
                {statuses[i] === "mining" && <span className="dim"> (mining…)</span>}
              </span>
            </li>
          ))}
        </ul>
        {err && <div className="step-fail-box">{err}</div>}
        <div className="modal-actions">
          {failedAt >= 0 && (
            <button className="btn btn-gold" onClick={() => void runFrom(failedAt)}>
              Retry from step {failedAt + 1}
            </button>
          )}
          <button className="btn" onClick={onClose}>
            {allDone ? "Done" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}

function safeParse(v: string, decimals: number): bigint {
  try {
    return parseUnits(v || "0", decimals);
  } catch {
    return 0n;
  }
}

