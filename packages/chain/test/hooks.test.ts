import { describe, it, expect } from "vitest";
import { classifyHook, hookPermissions, hookTakesSwapDelta, HOOK_FLAGS } from "../src/hooks.ts";
import { ADDRESSES } from "../src/chain.ts";
import type { Address } from "viem";

/** Build a synthetic hook address with exactly these permission bits. */
function hookAddr(bits: number): Address {
  return `0x${(0xabcdn * 2n ** 14n + BigInt(bits)).toString(16).padStart(40, "0")}` as Address;
}

describe("hookPermissions", () => {
  it("decodes flag bits from the address", () => {
    const addr = hookAddr(HOOK_FLAGS.beforeSwap | HOOK_FLAGS.afterInitialize);
    expect(hookPermissions(addr).sort()).toEqual(["afterInitialize", "beforeSwap"].sort());
  });

  it("the deployed Friar hooks decode to afterInitialize + beforeSwap", () => {
    for (const a of [ADDRESSES.friarStandard, ADDRESSES.friarCalm]) {
      expect(hookPermissions(a as Address).sort()).toEqual(["afterInitialize", "beforeSwap"].sort());
    }
  });
});

describe("classifyHook", () => {
  it("hookless pools are ok", () => {
    expect(classifyHook("0x0000000000000000000000000000000000000000").level).toBe("ok");
  });

  it("Friar hooks are ok", () => {
    expect(classifyHook(ADDRESSES.friarStandard as Address).level).toBe("ok");
    expect(classifyHook(ADDRESSES.friarCalm as Address).level).toBe("ok");
  });

  it("swap-only hooks are ok", () => {
    const v = classifyHook(hookAddr(HOOK_FLAGS.beforeSwap | HOOK_FLAGS.afterSwap | HOOK_FLAGS.beforeSwapReturnsDelta));
    expect(v.level).toBe("ok");
  });

  it("remove-liquidity permissions block (exit could be trapped or taxed)", () => {
    expect(classifyHook(hookAddr(HOOK_FLAGS.beforeRemoveLiquidity)).level).toBe("block");
    expect(classifyHook(hookAddr(HOOK_FLAGS.afterRemoveLiquidity)).level).toBe("block");
    expect(classifyHook(hookAddr(HOOK_FLAGS.afterRemoveLiquidity | HOOK_FLAGS.afterRemoveLiquidityReturnsDelta)).level).toBe(
      "block",
    );
  });

  it("add-liquidity permissions warn (recoverable: open reverts or pay caps bound it)", () => {
    expect(classifyHook(hookAddr(HOOK_FLAGS.beforeAddLiquidity)).level).toBe("warn");
    expect(classifyHook(hookAddr(HOOK_FLAGS.afterAddLiquidity | HOOK_FLAGS.afterAddLiquidityReturnsDelta)).level).toBe("warn");
  });

  it("block wins over warn when both are present", () => {
    const v = classifyHook(hookAddr(HOOK_FLAGS.beforeAddLiquidity | HOOK_FLAGS.beforeRemoveLiquidity));
    expect(v.level).toBe("block");
  });
});

describe("hookTakesSwapDelta", () => {
  it("only the two returns-delta swap bits count", () => {
    expect(hookTakesSwapDelta(hookAddr(HOOK_FLAGS.beforeSwapReturnsDelta))).toBe(true);
    expect(hookTakesSwapDelta(hookAddr(HOOK_FLAGS.afterSwapReturnsDelta))).toBe(true);
  });

  it("plain swap hooks cannot touch the swapper's delta", () => {
    // v4 zeroes the hook delta without the returns-delta flag, so a fee-override or
    // oracle hook is harmless as a zap venue
    expect(hookTakesSwapDelta(hookAddr(HOOK_FLAGS.beforeSwap | HOOK_FLAGS.afterSwap))).toBe(false);
    expect(hookTakesSwapDelta("0x0000000000000000000000000000000000000000")).toBe(false);
  });

  it("the deployed Friar hooks are not delta-taking", () => {
    for (const a of [ADDRESSES.friarStandard, ADDRESSES.friarCalm]) {
      expect(hookTakesSwapDelta(a as Address)).toBe(false);
    }
  });

  it("flags the dominant Robinhood Chain launchpad hook (afterSwapReturnsDelta)", () => {
    // 0x4e34...a544 — 305 of 686 pools initialized in a recent 100k-block window
    expect(hookTakesSwapDelta("0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544")).toBe(true);
  });
});
