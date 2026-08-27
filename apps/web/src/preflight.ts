/**
 * Can this wallet actually pay for the plan it is looking at?
 *
 * Pulled out of the open flow and made pure because the money question was decided by a
 * ternary that failed OPEN: an unanswered `balanceOf` read is `undefined`, `undefined`
 * folded into "no shortfall", and the screen showed a green "balance 0 ✓" above a live
 * Open button. On 2026-07-26 the only outside wallet ever to reach the wallet prompt did
 * so holding 0.005 WETH against a 0.1 plan and zero ETH for gas — the wallet's own
 * greyed-out Confirm was the first thing to tell them, and they rejected and left.
 *
 * The rule this encodes: a balance we could not read is UNKNOWN, never sufficient, and
 * unknown blocks. Nothing here talks to the chain, so the cases below are testable.
 */

export type PreflightInput = {
  /** `undefined` = the read hasn't landed (loading, RPC error, throttled) — NOT zero. */
  quoteBal: bigint | undefined;
  baseBal: bigint | undefined;
  nativeBal: bigint | undefined;
  quoteNeeded: bigint;
  baseNeeded: bigint;
  /** the quote is WETH, so a shortfall can be closed by wrapping native ETH in-flow */
  quoteIsWeth: boolean;
  /** "both" mode pulls the base token from the wallet; zap mode buys it instead */
  needsBase: boolean;
  /** native cushion held back from a wrap so the open still has gas */
  gasReserve: bigint;
};

export type PreflightResult = {
  quoteShort: bigint;
  /** native ETH to wrap before the open; 0 when wrapping can't cover the shortfall */
  wrapAmount: bigint;
  insufficientQuote: boolean;
  insufficientBase: boolean;
  /** zero native balance: no transaction in this flow can be sent at all */
  noGas: boolean;
  /** has gas, but under the cushion — worth saying, not worth blocking */
  lowGas: boolean;
  /** at least one balance this decision depends on never answered */
  unknown: boolean;
  /** the open must not be offered */
  blocked: boolean;
};

export function preflight(i: PreflightInput): PreflightResult {
  const quoteShort =
    i.quoteBal !== undefined && i.quoteBal < i.quoteNeeded ? i.quoteNeeded - i.quoteBal : 0n;
  const nativeAvail = i.nativeBal ?? 0n;
  // Wrappable only if the shortfall AND a gas cushion both fit in the native balance.
  const wrapAmount =
    i.quoteIsWeth && quoteShort > 0n && nativeAvail > quoteShort + i.gasReserve ? quoteShort : 0n;

  const insufficientQuote = quoteShort > 0n && wrapAmount === 0n;
  const insufficientBase = i.needsBase && i.baseBal !== undefined && i.baseBal < i.baseNeeded;
  const noGas = i.nativeBal === 0n;
  const lowGas = i.nativeBal !== undefined && i.nativeBal > 0n && i.nativeBal < i.gasReserve;
  const unknown =
    i.quoteBal === undefined || i.nativeBal === undefined || (i.needsBase && i.baseBal === undefined);

  return {
    quoteShort,
    wrapAmount,
    insufficientQuote,
    insufficientBase,
    noGas,
    lowGas,
    unknown,
    blocked: noGas || insufficientQuote || insufficientBase || unknown,
  };
}
