import { useEffect, useState } from "react";
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { erc20Abi, type Address } from "viem";
import {
  friarPositionManagerAbi,
  friarPositionManagerV1ExitsAbi,
  stateViewAbi,
  ADDRESSES,
  getSlot0,
  getLiquidity,
  hookTakesSwapDelta,
  managerForPosition,
  type PoolKey,
} from "@friar/chain";
import { getTickAtSqrtPrice, price1e18 } from "@friar/core";
import {
  findSwapVenue,
  findRouterPool,
  fetchToken,
  publicClient,
  v2RouterAbi,
  v3RouterAbi,
  estimateSellImpactPct,
  MAX_HOME_EXIT_IMPACT_PCT,
} from "../plan.js";
import { INDEXER_BASE } from "./OpenPosition.js";
import { useStepper } from "./StepperHost.js";
import { humanErr, report } from "../errors.js";
import type { ApiPositionDetail } from "../api.js";

/** Eager ingest of a just-confirmed manager tx (close/collect) — pushes its events into
 * D1 now instead of waiting for the indexer cursor to crawl to that block, so the card
 * flips to closed / updates fees immediately (mirrors the open flow). Retries through the
 * brief RPC-receipt race; best-effort — on failure the cursor pass still gets there. */
async function ingestTxEager(hash: `0x${string}`): Promise<void> {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`${INDEXER_BASE}/ingest-tx?hash=${hash}`);
      if (r.ok && (((await r.json()) as { events?: number }).events ?? 0) > 0) return;
    } catch {
      /* transient — retry */
    }
    await new Promise((res) => setTimeout(res, 700));
  }
}

export function keyFromPosition(p: ApiPositionDetail): { key: PoolKey; quoteIs0: boolean } {
  const key: PoolKey = {
    currency0: p.currency0 as Address,
    currency1: p.currency1 as Address,
    fee: (p as unknown as { fee: number }).fee,
    tickSpacing: (p as unknown as { tick_spacing: number }).tick_spacing,
    hooks: (p as unknown as { hooks: string }).hooks as Address,
  };
  const quotes = [ADDRESSES.usdg.toLowerCase(), ADDRESSES.weth.toLowerCase()];
  return { key, quoteIs0: quotes.includes(p.currency0.toLowerCase()) };
}

/** Live pool price straight from the chain — no indexer lag, no frozen-tick lies
 * from snapshots. Polls every 3s. */
export function useLivePool(poolId: string) {
  const slot0 = useReadContract({
    address: ADDRESSES.stateView as Address,
    abi: stateViewAbi,
    functionName: "getSlot0",
    args: [poolId as `0x${string}`],
    query: { refetchInterval: 3000 },
  });
  if (!slot0.data) return null;
  const [sqrtPriceX96, tick, , lpFee] = slot0.data;
  return { sqrtPriceX96, tick, lpFee, price: price1e18(sqrtPriceX96), approxTick: getTickAtSqrtPrice(sqrtPriceX96) };
}

export function PositionActions({
  position,
  onChanged,
  onBusyChange,
}: {
  position: ApiPositionDetail;
  onChanged: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { key, quoteIs0 } = keyFromPosition(position);
  const { address } = useAccount();
  const write = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: write.data });
  const runStepper = useStepper();
  const [stepperActive, setStepperActive] = useState(false);
  const [zapNote, setZapNote] = useState<string | null>(null);
  const isOpen = position.closed_ts === null;

  // Auto-refresh after a single-tx action — but NOT while a guided stepper runs (its
  // sub-txs also land here; it refreshes via its own onAllDone). Eager-ingest the tx
  // first (like opens) so the refetch sees the new state immediately instead of waiting
  // minutes for the indexer cursor to reach the close block. The guided stepper itself
  // lives in the app-root host (useStepper), so it survives this component unmounting.
  useEffect(() => {
    if (receipt.isSuccess && !stepperActive) {
      let cancelled = false;
      void (async () => {
        if (write.data) await ingestTxEager(write.data);
        if (!cancelled) onChanged();
      })();
      return () => {
        cancelled = true;
      };
    }
  }, [receipt.isSuccess, onChanged, stepperActive, write.data]);

  // keep the action row + busy state visible while a stepper is active (belt-and-suspenders:
  // the modal itself is hosted at the app root and no longer depends on staying mounted)
  useEffect(() => {
    onBusyChange?.(stepperActive);
  }, [stepperActive, onBusyChange]);

  const noZap = { enabled: false, venue: key, zeroForOne: false };
  const id = BigInt(position.position_id);
  const busy = write.isPending || receipt.isLoading;

  useEffect(() => {
    if (write.error)
      report("position action", write.error, { positionId: position.position_id, poolId: position.pool_id });
  }, [write.error, position.position_id, position.pool_id]);

  // A position is exited against the manager it was OPENED on, never whichever one is
  // current — managers are immutable, so an upgrade must not strand anyone. `deployment`
  // also selects the ABI generation: v2 exits carry maxPay0/maxPay1, v1 exits don't.
  const deployment = managerForPosition(position);
  const isLegacy = deployment.exitAbi === "v1";

  // maxPay0/maxPay1 are always 0: an exit must never pull funds from the owner's wallet.
  // Without that cap a zap venue whose hook returns an unbounded swap delta turns "close
  // my position" into a withdrawal against the manager's ERC-20 allowance. Legacy
  // managers have no such cap, which is why their zap path is disabled below.
  const call = (functionName: "collect" | "close", zap: typeof noZap, min0 = 0n, min1 = 0n) =>
    isLegacy
      ? write.writeContract({
          address: deployment.address,
          abi: friarPositionManagerV1ExitsAbi,
          functionName,
          args: [id, zap, min0, min1],
        })
      : write.writeContract({
          address: deployment.address,
          abi: friarPositionManagerAbi,
          functionName,
          args: [id, zap, min0, min1, 0n, 0n],
        });

  // zap-out: deepest *price-sane* v4 venue in-unlock when one exists; otherwise a guided
  // two-step — close, then swap the returned tokens on the router (v3 pool or v2 pair).
  const callZapClose = async () => {
    // Execution anchor: the indexer's true-market mark when we have one (a breached
    // pool's own tick freezes and lies — CASHCAT), else the pool's live price. Venues
    // priced off this anchor are rejected regardless of depth.
    const snap = position.latestSnapshot;
    let refSqrt = snap ? BigInt(snap.market_sqrt_price ?? snap.sqrt_price) : 0n;

    // The home pool is normally excluded because the depth probe would count this
    // position's own about-to-burn bins (sole-LP case: probe sees a deep pool, the
    // swap lands in an empty one). But when OTHER LPs' post-burn active liquidity can
    // absorb the token side at low impact, the home pool is the best venue — the exit
    // fee stays with the remaining Friar LPs instead of leaking to an outside pool.
    let exclude: string | undefined = position.pool_id;
    try {
      const pid = position.pool_id as `0x${string}`;
      const [slot0, activeL] = await Promise.all([getSlot0(publicClient, pid), getLiquidity(publicClient, pid)]);
      if (refSqrt === 0n) refSqrt = slot0.sqrtPriceX96;
      const mine = position.bins.find((b) => b.tick_lower <= slot0.tick && slot0.tick < b.tick_upper);
      const othersL = activeL - BigInt(mine?.liquidity ?? "0");
      const tokenSide = snap
        ? BigInt(quoteIs0 ? snap.amount1 : snap.amount0) + BigInt(quoteIs0 ? snap.fees1 : snap.fees0)
        : 0n;
      if (
        tokenSide > 0n &&
        othersL > 0n &&
        estimateSellImpactPct(othersL, slot0.sqrtPriceX96, tokenSide, !quoteIs0) <= MAX_HOME_EXIT_IMPACT_PCT
      )
        exclude = undefined;
    } catch {
      /* chain read failed — stay conservative: home pool excluded, snapshot anchor only */
    }
    const best = await findSwapVenue(
      key.currency0 as Address,
      key.currency1 as Address,
      exclude,
      refSqrt > 0n ? refSqrt : undefined,
    );
    // Legacy managers have no maxPay caps, so an in-unlock zap there can be made to settle
    // a debt from the wallet by a venue whose hook returns an unbounded swap delta. Those
    // positions skip the in-unlock route entirely and take the two-step path below: plain
    // close (touches no hook at all), then sell on the router with an explicit min-out.
    if (best && !isLegacy) {
      // Floor the quote payout at the last marked value less the venue fee and a 5%
      // impact/staleness allowance — a mispriced or moved venue reverts the close
      // instead of silently realizing the loss. (Marked value absent → no floor, but
      // the venue itself passed the price band above.)
      const marked = BigInt(position.summary?.valueQuote ?? "0");
      const afterFee = (marked * BigInt(1_000_000 - best.slot0.lpFee)) / 1_000_000n;
      const floor = (afterFee * 95n) / 100n;
      // Launchpad venues (Doppler/Clanker/Pons-style) collect their swap fee via a hook
      // delta, so we can't screen them out without losing the primary liquidity for the
      // tokens people actually LP. Surface it instead — the on-chain pay caps are what
      // bound the downside, this just tells the user whose venue they're crossing.
      if (hookTakesSwapDelta(best.key.hooks as Address)) {
        setZapNote(
          `routing through a hooked venue (${best.key.hooks.slice(0, 8)}…) that takes its own swap fee — your payout floor and pay caps still apply`,
        );
      }
      call("close", { enabled: true, venue: best.key, zeroForOne: !quoteIs0 }, quoteIs0 ? floor : 0n, quoteIs0 ? 0n : floor);
      return;
    }
    const tokenAddr = (quoteIs0 ? key.currency1 : key.currency0) as Address;
    const quoteAddr = (quoteIs0 ? key.currency0 : key.currency1) as Address;
    const quoteDec = quoteAddr.toLowerCase() === ADDRESSES.usdg.toLowerCase() ? 6 : 18;
    const rp = await findRouterPool(tokenAddr, quoteAddr);
    if (!rp || !address) {
      // no swap route to the quote — DON'T silently close-and-keep. Tell the user; they can
      // close and keep tokens explicitly, then sell it from the closed view.
      setZapNote(`no ${shortSym(quoteAddr)} route for this token — use “Close” (keeps the tokens), then sell it from the closed view`);
      return;
    }
    const token = await fetchToken(tokenAddr);
    // Sell the FULL wallet balance after close, not just this close's delta. "Zap = fully
    // exit": the old delta (bal − preBal) stranded the token-side fee — already sitting in
    // the wallet from an earlier claim/close — as dust; a full-balance sweep clears it too.
    // Read at execution time so it's exact. (Plain "Close" is the keep-the-tokens path.)
    const walletBalance = () =>
      publicClient.readContract({ address: tokenAddr, abi: erc20Abi, functionName: "balanceOf", args: [address] });
    let closeHash: `0x${string}` | undefined; // captured for eager-ingest on completion
    setStepperActive(true);
    runStepper({
      title: "Closing position",
      steps: [
        {
          label: "close position",
          detail: "burn all bins — principal + fees return to your wallet",
          run: async () => {
            closeHash = isLegacy
              ? await write.writeContractAsync({ address: deployment.address, abi: friarPositionManagerV1ExitsAbi, functionName: "close", args: [id, noZap, 0n, 0n] })
              : await write.writeContractAsync({ address: deployment.address, abi: friarPositionManagerAbi, functionName: "close", args: [id, noZap, 0n, 0n, 0n, 0n] });
            return closeHash;
          },
        },
        {
          label: `approve ${token.symbol}`,
          detail: "allow the swap router to sell your full balance",
          run: async () =>
            write.writeContractAsync({ address: tokenAddr, abi: erc20Abi, functionName: "approve", args: [ADDRESSES.v3SwapRouter02 as Address, await walletBalance()] }),
        },
        {
          label: `swap ${token.symbol} → ${shortSym(quoteAddr)}`,
          detail: `sell your ${token.symbol} on the ${rp.kind} pool (fee ${(rp.fee / 10_000).toFixed(2)}%, min-out guarded)`,
          run: async () => {
            const amt = await walletBalance();
            const human = Number(amt) / 10 ** token.decimals;
            const minOut = BigInt(Math.floor(human * rp.priceNative * (1 - rp.fee / 1e6) * 0.95 * 10 ** quoteDec));
            return rp.kind === "v3"
              ? write.writeContractAsync({
                  address: ADDRESSES.v3SwapRouter02 as Address,
                  abi: v3RouterAbi,
                  functionName: "exactInputSingle",
                  args: [{ tokenIn: tokenAddr, tokenOut: quoteAddr, fee: rp.fee, recipient: address, amountIn: amt, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
                })
              : write.writeContractAsync({
                  address: ADDRESSES.v3SwapRouter02 as Address,
                  abi: v2RouterAbi,
                  functionName: "swapExactTokensForTokens",
                  args: [amt, minOut, [tokenAddr, quoteAddr], address],
                });
          },
        },
      ],
      onAllDone: () => {
        setStepperActive(false);
        void (async () => {
          if (closeHash) await ingestTxEager(closeHash);
          onChanged();
        })();
      },
      onClose: () => setStepperActive(false),
    });
  };

  return (
    <>
      {isOpen && (
        <>
          <button className="btn" disabled={busy} onClick={() => call("collect", noZap)}>
            Claim fees
          </button>
          <button className="btn" disabled={busy} onClick={() => call("close", noZap)}>
            Close
          </button>
          <button className="btn btn-gold" disabled={busy} onClick={() => void callZapClose()}>
            Close &amp; zap to {quoteIs0 ? shortSym(position.currency0) : shortSym(position.currency1)}
          </button>
        </>
      )}
      {busy && <span className="mono dim" style={{ fontSize: 12, alignSelf: "center" }}>{write.isPending ? "confirm in wallet…" : "mining…"}</span>}
      {write.error && <span className="mono red" style={{ fontSize: 12, alignSelf: "center" }}>{humanErr(write.error)}</span>}
      {zapNote && <span className="mono warn" style={{ fontSize: 12, alignSelf: "center" }}>{zapNote}</span>}
      {receipt.isSuccess && !stepperActive && (
        <span className="mono green" style={{ fontSize: 12, alignSelf: "center" }}>done ✓ refreshing…</span>
      )}
    </>
  );
}

function shortSym(addr: string): string {
  const known: Record<string, string> = {
    [ADDRESSES.weth.toLowerCase()]: "WETH",
    [ADDRESSES.usdg.toLowerCase()]: "USDG",
  };
  return known[addr.toLowerCase()] ?? "quote";
}
