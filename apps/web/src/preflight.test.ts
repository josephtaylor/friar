import { describe, it, expect } from "vitest";
import { parseEther } from "viem";
import { preflight, type PreflightInput } from "./preflight.js";

const GAS_RESERVE = 10n ** 15n; // 0.001 ETH, as in OpenPosition

/** zap-mode open of 0.1 WETH into a token, the default the app loads with */
const base = (over: Partial<PreflightInput> = {}): PreflightInput => ({
  quoteBal: parseEther("1"),
  baseBal: undefined,
  nativeBal: parseEther("1"),
  quoteNeeded: parseEther("0.1"),
  baseNeeded: 0n,
  quoteIsWeth: true,
  needsBase: false,
  gasReserve: GAS_RESERVE,
  ...over,
});

describe("preflight", () => {
  it("passes a funded wallet", () => {
    const r = preflight(base());
    expect(r.blocked).toBe(false);
    expect(r.unknown).toBe(false);
    expect(r.noGas).toBe(false);
    expect(r.wrapAmount).toBe(0n);
  });

  // The regression this module exists for: 0x33Ed…7B6b, 2026-07-26, the only outside
  // wallet ever to reach a Friar wallet prompt. It held 0.005 WETH against the default
  // 0.1 plan and zero ETH, so the approve it was shown could only ever be rejected.
  it("blocks the wallet that reached the approve prompt on 2026-07-26", () => {
    const r = preflight(base({ quoteBal: parseEther("0.005"), nativeBal: 0n }));
    expect(r.noGas).toBe(true);
    expect(r.insufficientQuote).toBe(true);
    expect(r.wrapAmount).toBe(0n); // nothing to wrap with
    expect(r.blocked).toBe(true);
  });

  it("blocks on zero gas even when the quote balance covers the plan", () => {
    const r = preflight(base({ nativeBal: 0n }));
    expect(r.noGas).toBe(true);
    expect(r.insufficientQuote).toBe(false);
    expect(r.blocked).toBe(true);
  });

  it("treats an unread balance as unknown, not as sufficient", () => {
    const r = preflight(base({ quoteBal: undefined }));
    expect(r.unknown).toBe(true);
    expect(r.blocked).toBe(true);
    // the old bug: undefined folded into "no shortfall", so nothing flagged it
    expect(r.insufficientQuote).toBe(false);
    expect(r.quoteShort).toBe(0n);
  });

  it("treats an unread native balance as unknown rather than as no gas", () => {
    const r = preflight(base({ nativeBal: undefined }));
    expect(r.unknown).toBe(true);
    expect(r.noGas).toBe(false);
    expect(r.blocked).toBe(true);
  });

  it("only waits on the base balance when the mode actually spends it", () => {
    expect(preflight(base({ baseBal: undefined, needsBase: false })).unknown).toBe(false);
    expect(preflight(base({ baseBal: undefined, needsBase: true })).unknown).toBe(true);
  });

  it("closes a WETH shortfall by wrapping when native covers it plus the cushion", () => {
    const r = preflight(base({ quoteBal: 0n, nativeBal: parseEther("0.5") }));
    expect(r.wrapAmount).toBe(parseEther("0.1"));
    expect(r.insufficientQuote).toBe(false);
    expect(r.blocked).toBe(false);
  });

  it("won't wrap the gas cushion away", () => {
    // exactly the shortfall, nothing left for gas
    const r = preflight(base({ quoteBal: 0n, nativeBal: parseEther("0.1") }));
    expect(r.wrapAmount).toBe(0n);
    expect(r.insufficientQuote).toBe(true);
    expect(r.blocked).toBe(true);
  });

  it("won't wrap for a non-WETH quote", () => {
    const r = preflight(base({ quoteBal: 0n, quoteIsWeth: false, nativeBal: parseEther("5") }));
    expect(r.wrapAmount).toBe(0n);
    expect(r.insufficientQuote).toBe(true);
  });

  it("warns on dust gas without blocking", () => {
    const r = preflight(base({ nativeBal: GAS_RESERVE - 1n }));
    expect(r.lowGas).toBe(true);
    expect(r.noGas).toBe(false);
    expect(r.blocked).toBe(false);
  });

  it("blocks a short base balance in both-sided mode", () => {
    const r = preflight(base({ needsBase: true, baseBal: 1n, baseNeeded: 1000n }));
    expect(r.insufficientBase).toBe(true);
    expect(r.blocked).toBe(true);
  });
});
