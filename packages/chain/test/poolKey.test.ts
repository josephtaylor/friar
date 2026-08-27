import { test, expect } from "vitest";
import { encodePoolKey, poolId } from "../src/poolKey.js";
import { binSalt } from "../src/stateView.js";

const key = {
  currency0: "0x020bfC650A365f8BB26819deAAbF3E21291018b4",
  currency1: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  fee: 0x800000,
  tickSpacing: 100,
  hooks: "0xFeDa24F0d3805170E7566cE617CfBa01cE05D080",
} as const;

test("encodePoolKey: five words, addresses right-aligned (parity with poacher)", () => {
  const enc = encodePoolKey(key).slice(2);
  expect(enc.length).toBe(5 * 64);
  expect(enc.startsWith("000000000000000000000000020bfc65")).toBe(true);
  expect(enc.includes("0000000000000000000000000000000000000000000000000000000000800000")).toBe(true);
});

test("poolId: keccak of encoded key, 32 bytes", () => {
  const id = poolId(key);
  expect(id).toMatch(/^0x[0-9a-f]{64}$/);
  // deterministic
  expect(poolId({ ...key })).toBe(id);
});

test("binSalt: keccak(abi.encodePacked(positionId, index))", () => {
  const s = binSalt(1n, 0n);
  expect(s).toMatch(/^0x[0-9a-f]{64}$/);
  expect(binSalt(1n, 1n)).not.toBe(s);
  expect(binSalt(2n, 0n)).not.toBe(s);
});
