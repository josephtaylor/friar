// Pair → token/quote resolution + ERC-20 symbol lookup. Quote = whichever side is
// USDG or WETH (USDG prioritized, matching the API's quote detection); token = the
// other. quoteIs0 drives every chart/range/status orientation in the app.
import { useQuery } from "@tanstack/react-query";
import { ADDRESSES } from "@friar/chain";

const USDG = ADDRESSES.usdg.toLowerCase();
const WETH = ADDRESSES.weth.toLowerCase();
const QUOTES = [USDG, WETH];

export function quoteSymbol(addr: string): string {
  const a = addr.toLowerCase();
  return a === USDG ? "USDG" : a === WETH ? "WETH" : "quote";
}

export function splitPair(currency0: string, currency1: string): {
  token: string;
  quote: string;
  quoteSym: string;
  quoteIs0: boolean;
} {
  const quoteIs0 = QUOTES.includes(currency0.toLowerCase());
  const token = quoteIs0 ? currency1 : currency0;
  const quote = quoteIs0 ? currency0 : currency1;
  return { token, quote, quoteSym: quoteSymbol(quote), quoteIs0 };
}

/** Resolve an ERC-20 symbol/decimals (cached forever — symbols don't change). */
export function useTokenSymbol(addr?: string) {
  return useQuery({
    queryKey: ["sym", addr?.toLowerCase()],
    enabled: !!addr && /^0x[0-9a-fA-F]{40}$/.test(addr),
    staleTime: Infinity,
    queryFn: async () => (await import("./plan.js")).fetchToken(addr as `0x${string}`),
  });
}

export function shortAddr(addr: string, head = 6, tail = 4): string {
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}
