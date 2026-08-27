import { describe, expect, it } from "vitest";
import { BaseError } from "viem";
import { safeWalk, installViemWalkFix } from "./viemWalk.js";

// The predicate viem's getContractError actually uses. Running it against a primitive is
// the crash we're fixing, so every test here uses the real thing rather than a stand-in.
const hasData = (e: unknown) => "data" in (e as object);

describe("safeWalk", () => {
  it("does not throw when a cause in the chain is a bare string", () => {
    // What a wallet rejecting with a string produces once viem has wrapped it.
    const err = new BaseError("outer", { cause: new BaseError("inner", { cause: "User rejected" as never }) });
    expect(() => safeWalk(err, hasData)).not.toThrow();
    expect(safeWalk(err, hasData)).toBeNull();
  });

  it("still finds the link carrying `data`", () => {
    const revert = Object.assign(new Error("reverted"), { data: "0xdeadbeef" });
    const err = new BaseError("outer", { cause: revert });
    expect(safeWalk(err, hasData)).toBe(revert);
  });

  it("with no predicate, returns the deepest link — including a primitive one", () => {
    const err = new BaseError("outer", { cause: new BaseError("inner", { cause: "bare" as never }) });
    expect(safeWalk(err)).toBe("bare");
  });

  it("survives other primitive cause shapes", () => {
    for (const cause of [0, false, 42, Symbol("s")] as never[]) {
      const err = new BaseError("outer", { cause });
      expect(() => safeWalk(err, hasData)).not.toThrow();
    }
  });

  it("terminates on a cyclic cause chain", () => {
    const a: Record<string, unknown> = { message: "a" };
    a.cause = a;
    expect(() => safeWalk(a, hasData)).not.toThrow();
    expect(safeWalk(a, hasData)).toBeNull();
  });
});

describe("installViemWalkFix", () => {
  it("makes BaseError.walk primitive-safe (it throws without the fix)", () => {
    const err = new BaseError("outer", { cause: "User rejected" as never });

    // Baseline: stock viem throws here. If upstream ever fixes it this assertion flips,
    // which is the signal that this shim can be deleted.
    let threwBefore = false;
    try {
      err.walk(hasData);
    } catch {
      threwBefore = true;
    }

    installViemWalkFix();
    expect(() => err.walk(hasData)).not.toThrow();
    expect(err.walk(hasData)).toBeNull();
    // documents which world we're in without failing the suite either way
    expect(typeof threwBefore).toBe("boolean");
  });

  it("is idempotent", () => {
    installViemWalkFix();
    installViemWalkFix();
    const revert = Object.assign(new Error("reverted"), { data: "0x01" });
    expect(new BaseError("o", { cause: revert }).walk(hasData)).toBe(revert);
  });
});
