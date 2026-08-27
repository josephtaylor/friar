import { describe, it, expect } from "vitest";
import { FEE_TIERS, deployedFeeTiers, feeTierForHook, isFriarTierHook } from "../src/feeTiers.ts";

describe("fee-tier registry", () => {
  it("ships exactly 0.30 / 0.80 / 1 / 2 / 5%, pct and pips consistent, ascending", () => {
    expect(FEE_TIERS.map((t) => t.pct)).toEqual([0.3, 0.8, 1, 2, 5]);
    for (const t of FEE_TIERS) expect(t.pips).toBe(Math.round(t.pct * 10_000)); // 1% = 10_000 pips
    const pips = FEE_TIERS.map((t) => t.pips);
    expect([...pips].sort((a, b) => a - b)).toEqual(pips);
  });

  it("treats an undeployed tier as not-live: no hook is recognised, dropdown stays empty", () => {
    // pre-deploy every hook is null
    if (FEE_TIERS.every((t) => t.hook === null)) {
      expect(deployedFeeTiers()).toEqual([]);
      expect(isFriarTierHook("0x000000000000000000000000000000000000dEaD")).toBe(false);
      expect(feeTierForHook(null)).toBeUndefined();
    } else {
      // once addresses are filled, deployed tiers are the non-null ones and resolve back
      const live = deployedFeeTiers();
      expect(live.length).toBeGreaterThan(0);
      for (const t of live) {
        expect(feeTierForHook(t.hook)).toEqual(t);
        expect(feeTierForHook(t.hook!.toUpperCase().replace("0X", "0x"))).toEqual(t); // case-insensitive
        expect(isFriarTierHook(t.hook)).toBe(true);
      }
    }
  });
});
