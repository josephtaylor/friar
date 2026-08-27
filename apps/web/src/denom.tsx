// Display denomination (ETH vs USD) — a first-class, app-wide axis. Defaults to ETH
// (the founder's style); switchable for USD-denominated LPers. This is PURELY a display
// concern: the pool quote and all accounting stay in WETH terms; USD is a ×rate view
// (rate = USD per WETH, from /rate). Persisted to localStorage.
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api.js";
import { fmtMoney, signedMoney, moneyUnit, type Denom } from "./format.js";

const KEY = "friar.denom";

interface DenomCtx {
  denom: Denom; // the user's selection (what the toggle shows)
  setDenom: (d: Denom) => void;
  rate: number | null; // USD per WETH, or null until loaded / on failure
}
const Ctx = createContext<DenomCtx | null>(null);

export function DenomProvider({ children }: { children: ReactNode }) {
  const [denom, setDenomState] = useState<Denom>(() =>
    (typeof localStorage !== "undefined" && localStorage.getItem(KEY)) === "USD" ? "USD" : "ETH",
  );
  const setDenom = useCallback((d: Denom) => {
    setDenomState(d);
    try {
      localStorage.setItem(KEY, d);
    } catch {
      /* private mode — selection just won't persist */
    }
  }, []);

  // Only fetch the rate when USD is actually in play — ETH-default users never call it.
  const rateQ = useQuery({
    queryKey: ["usdRate"],
    queryFn: () => api.rate(),
    enabled: denom === "USD",
    refetchInterval: 60_000,
    staleTime: 60_000,
  });

  return <Ctx.Provider value={{ denom, setDenom, rate: rateQ.data?.usdPerWeth ?? null }}>{children}</Ctx.Provider>;
}

export function useDenom(): DenomCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useDenom must be used within DenomProvider");
  return c;
}

/**
 * Money formatters bound to the current denomination. Until a USD rate loads, the
 * EFFECTIVE denom stays ETH so numbers and their unit never disagree — the display
 * flips to USD only once the rate is in hand (a sub-second gap after the first toggle).
 */
export function useMoney() {
  const { denom, rate } = useDenom();
  const effective: Denom = denom === "USD" && rate != null ? "USD" : "ETH";
  return {
    denom: effective,
    unit: moneyUnit(effective),
    fmt: (v: string | bigint, digits?: number) => fmtMoney(v, effective, rate, digits),
    signed: (v: string | bigint, digits?: number) => signedMoney(v, effective, rate, digits),
  };
}

/** Segmented ETH/USD switch for the top bar. */
export function DenomToggle() {
  const { denom, setDenom } = useDenom();
  return (
    <div className="denom-toggle" role="group" aria-label="display denomination">
      <button className={denom === "ETH" ? "active" : ""} onClick={() => setDenom("ETH")} aria-pressed={denom === "ETH"}>
        Ξ
      </button>
      <button className={denom === "USD" ? "active" : ""} onClick={() => setDenom("USD")} aria-pressed={denom === "USD"}>
        $
      </button>
    </div>
  );
}
