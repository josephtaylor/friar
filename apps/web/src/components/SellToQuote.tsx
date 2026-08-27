import { useEffect, useRef, useState } from "react";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { erc20Abi, type Address } from "viem";
import { ADDRESSES } from "@friar/chain";
import { findRouterPool, fetchToken, publicClient, v2RouterAbi, v3RouterAbi } from "../plan.js";
import { useTokenSymbol } from "../tokens.js";
import { humanErr, report } from "../errors.js";
import { TxStepper, type TxStep } from "./OpenPosition.js";

/** Sell a token the wallet holds to the pool's QUOTE (WETH or USDG) through the token's
 * canonical v3 pool or v2 pair against that quote. Runs purely off the wallet balance,
 * so it's independent of any position's lifecycle — unlike the in-position zap, nothing
 * can tear this down mid-flow. Doubles as the leftover/dust sweeper and as the way to
 * finish a "close & kept tokens" exit. A token with no v3/v2 pool against this quote
 * can't be swept here (it'd need a multi-hop route) — we say so rather than pretend. */
export function SellToQuote({ token, quote, symbol, onDone }: { token: string; quote: string; symbol?: string; onDone?: () => void }) {
  const { address } = useAccount();
  const write = useWriteContract();
  const info = useTokenSymbol(token);
  const [steps, setSteps] = useState<TxStep[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);

  const quoteAddr = quote as Address;
  const isUsdg = quoteAddr.toLowerCase() === ADDRESSES.usdg.toLowerCase();
  const quoteSym = isUsdg ? "USDG" : "WETH";
  const quoteDec = isUsdg ? 6 : 18;

  const bal = useReadContract({
    address: token as Address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address!],
    query: { enabled: !!address, refetchInterval: 6000 },
  });
  const balance = bal.data ?? 0n;
  const decimals = info.data?.decimals ?? 18;
  const sym = symbol ?? info.data?.symbol ?? "token";
  const human = Number(balance) / 10 ** decimals;

  // sell the CURRENT balance, read at execution time (so it's exact even if it changed)
  const currentBalance = () =>
    publicClient.readContract({ address: token as Address, abi: erc20Abi, functionName: "balanceOf", args: [address!] });

  const start = async () => {
    if (!address || balance === 0n) return;
    setErr(null);
    setPreparing(true);
    try {
      const [rp, ti] = await Promise.all([findRouterPool(token as Address, quoteAddr), fetchToken(token as Address)]);
      if (!rp) {
        setErr(`no canonical v3/v2 ${quoteSym} pool found — sell it manually on the DEX`);
        return;
      }
      setSteps([
        {
          label: `approve ${ti.symbol}`,
          detail: "allow the swap router to spend your balance",
          run: async () =>
            write.writeContractAsync({
              address: token as Address,
              abi: erc20Abi,
              functionName: "approve",
              args: [ADDRESSES.v3SwapRouter02 as Address, await currentBalance()],
            }),
        },
        {
          label: `swap ${ti.symbol} → ${quoteSym}`,
          detail: `sell on the ${rp.kind} pool (fee ${(rp.fee / 10_000).toFixed(2)}%, 5% max slippage)`,
          run: async () => {
            const amt = await currentBalance();
            const humanAmt = Number(amt) / 10 ** ti.decimals;
            const minOut = BigInt(Math.floor(humanAmt * rp.priceNative * (1 - rp.fee / 1e6) * 0.95 * 10 ** quoteDec));
            return rp.kind === "v3"
              ? write.writeContractAsync({
                  address: ADDRESSES.v3SwapRouter02 as Address,
                  abi: v3RouterAbi,
                  functionName: "exactInputSingle",
                  args: [
                    {
                      tokenIn: token as Address,
                      tokenOut: quoteAddr,
                      fee: rp.fee,
                      recipient: address,
                      amountIn: amt,
                      amountOutMinimum: minOut,
                      sqrtPriceLimitX96: 0n,
                    },
                  ],
                })
              : write.writeContractAsync({
                  address: ADDRESSES.v3SwapRouter02 as Address,
                  abi: v2RouterAbi,
                  functionName: "swapExactTokensForTokens",
                  args: [amt, minOut, [token as Address, quoteAddr], address],
                });
          },
        },
      ]);
    } catch (e) {
      report("sell-to-quote — prepare", e);
      setErr(humanErr(e));
    } finally {
      setPreparing(false);
    }
  };

  // Loudly surface an incomplete exit: a closed position whose token still sits in the
  // wallet (a zap-out that stopped before its swap). Scroll it into view once so it isn't
  // missed below the fold.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (balance > 0n) cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [balance > 0n]);

  if (!address || balance === 0n) return null;

  return (
    <div
      ref={cardRef}
      className="card-box"
      style={{ display: "flex", flexDirection: "column", gap: 10, border: "1px solid #e0a92a", boxShadow: "0 0 0 1px #e0a92a33" }}
    >
      <div className="card-box-title" style={{ color: "#e0a92a" }}>⚠ Finish your exit</div>
      <div className="mono" style={{ fontSize: 13 }}>
        Your wallet still holds <b className="gold">{human.toLocaleString(undefined, { maximumFractionDigits: 2 })} {sym}</b> from
        this position — the exit didn’t fully swap. Sell it to {quoteSym} to complete the exit.
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button className="btn btn-gold" disabled={preparing || steps !== null} onClick={() => void start()}>
          {preparing ? "finding route…" : `Sell ${sym} → ${quoteSym}`}
        </button>
        {err && <span className="mono red" style={{ fontSize: 12 }}>{err}</span>}
      </div>
      {steps && (
        <TxStepper
          steps={steps}
          title={`Selling ${sym} → ${quoteSym}`}
          onAllDone={() => {
            setSteps(null);
            void bal.refetch();
            onDone?.();
          }}
          onClose={() => setSteps(null)}
        />
      )}
    </div>
  );
}
