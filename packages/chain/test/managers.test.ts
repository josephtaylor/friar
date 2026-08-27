import { describe, it, expect } from "vitest";
import {
  MANAGERS,
  currentManager,
  managerFor,
  managerForPosition,
  earliestManagerBlock,
  managerAddresses,
} from "../src/managers.ts";

describe("manager registry", () => {
  it("has exactly one current deployment", () => {
    expect(MANAGERS.filter((m) => m.current)).toHaveLength(1);
    expect(currentManager().current).toBe(true);
  });

  /** Position ids are one global namespace across managers (D1 keys positions by id
   * alone). Overlapping id ranges would silently clobber history on redeploy. */
  it("deploy blocks are strictly increasing, so id ranges can never overlap", () => {
    for (let i = 1; i < MANAGERS.length; i++) {
      expect(MANAGERS[i]!.deployBlock).toBeGreaterThan(MANAGERS[i - 1]!.deployBlock);
    }
  });

  /** The plain invariant, restored at the 2026-08-01 cutover (the flat-5% manager was
   * staged behind it from 07-31): the current deployment is the newest one. This is what
   * catches "added a manager and forgot to flip". If a future deployment stages again,
   * pin the staged address here the way the pre-cutover test did — deliberately failing
   * at flip time — rather than softening this into something that passes either way. */
  it("current is the newest deployment", () => {
    expect(currentManager().deployBlock).toBe(Math.max(...MANAGERS.map((m) => m.deployBlock)));
  });

  it("addresses are unique and checksummed 20-byte hex", () => {
    const seen = new Set(managerAddresses().map((a) => a.toLowerCase()));
    expect(seen.size).toBe(MANAGERS.length);
    for (const a of managerAddresses()) expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("looks managers up case-insensitively", () => {
    const m = MANAGERS[0]!;
    expect(managerFor(m.address.toLowerCase())?.address).toBe(m.address);
    expect(managerFor(m.address.toUpperCase().replace("0X", "0x"))?.address).toBe(m.address);
    expect(managerFor("0x000000000000000000000000000000000000dead")).toBeUndefined();
    expect(managerFor(null)).toBeUndefined();
  });

  /** Rows written before the `manager` column existed must still resolve, or their
   * owners lose the ability to exit from the UI. */
  it("resolves rows with a null manager to the oldest deployment", () => {
    expect(managerForPosition({ manager: null }).address).toBe(MANAGERS[0]!.address);
    expect(managerForPosition({}).address).toBe(MANAGERS[0]!.address);
  });

  it("resolves rows to their own manager, not the current one", () => {
    for (const m of MANAGERS) {
      expect(managerForPosition({ manager: m.address }).address).toBe(m.address);
    }
  });

  it("an unknown manager address falls back rather than throwing", () => {
    expect(managerForPosition({ manager: "0x000000000000000000000000000000000000dead" }).address).toBe(
      MANAGERS[0]!.address,
    );
  });

  it("earliestManagerBlock is the reindex floor", () => {
    expect(earliestManagerBlock()).toBe(Math.min(...MANAGERS.map((m) => m.deployBlock)));
  });

  /** Pins the live pricing: new opens pay a flat 5% on fees earned. An accidental revert
   *  to the tiered manager (or a fee edit on the flat one) should fail loudly here. */
  it("the current manager charges flat 5% for everyone", () => {
    const m = currentManager();
    expect(m.address.toLowerCase()).toBe("0xbd76176c5524785452d80c4350f18e3a2040470e");
    expect(m.feeModel).toEqual({ kind: "flat", pct: 5 });
  });
});
