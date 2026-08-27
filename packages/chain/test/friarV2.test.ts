import { describe, it, expect } from "vitest";
import {
  FRIAR_V2_DEFAULT_CONFIG,
  FRIAR_V2_SPACINGS,
  friarV2PoolKey,
} from "../src/friarV2.ts";
import { ADDRESSES } from "../src/chain.ts";
import { DYNAMIC_FEE_FLAG, poolId } from "../src/poolKey.ts";

const TOKEN = "0x1111111111111111111111111111111111111111";
const QUOTE_LOW = "0x0000000000000000000000000000000000000abc"; // sorts before TOKEN
const QUOTE_HIGH = "0xffffffffffffffffffffffffffffffffffffffff"; // sorts after TOKEN

describe("FriarV2 config", () => {
  /** Pins the constant to what 0x188D…5080 returns from defaultConfig(). If a redeploy
   *  changes the on-chain default, update this AND re-check every preset — a stale default
   *  means the UI proposes a config the manager's _assertConfigApplied will reject. Kept as
   *  a value check (not an RPC call) so the suite stays offline and the throttled public RPC
   *  can't flake it. Verified against chain 2026-07-31. */
  it("default config matches the on-chain defaultConfig() read", () => {
    expect(FRIAR_V2_DEFAULT_CONFIG).toEqual({
      baseFeePips: 9_000,
      filterPeriod: 10,
      decayPeriod: 600,
      reductionFactor: 5_000,
      variableFeeControl: 40_000,
      maxVolatilityTicks: 7_000,
    });
  });

  it("offers a short canonical spacing list, ascending and unique, incl. both rail defaults", () => {
    const values = FRIAR_V2_SPACINGS.map((s) => s.value);
    expect(new Set(values).size).toBe(values.length); // unique
    expect([...values].sort((a, b) => a - b)).toEqual(values); // ascending
    expect(values.length).toBeLessThanOrEqual(5); // "short" — the anti-fragmentation point
    // the app's rail defaults (160 WETH, 100 USDG) must be selectable or a default open can't
    // land on the same spacing the dropdown offers
    expect(values).toContain(160);
    expect(values).toContain(100);
  });
});

describe("friarV2PoolKey", () => {
  it("uses the FriarV2 hook and the dynamic-fee flag, never a static fee", () => {
    const { key } = friarV2PoolKey(TOKEN, QUOTE_HIGH, 160);
    expect(key.hooks.toLowerCase()).toBe(ADDRESSES.friarV2.toLowerCase());
    expect(key.fee).toBe(DYNAMIC_FEE_FLAG);
    expect(key.tickSpacing).toBe(160);
  });

  it("sorts currencies by address and reports quoteIs0 accordingly", () => {
    const lowQuote = friarV2PoolKey(TOKEN, QUOTE_LOW, 160);
    expect(lowQuote.quoteIs0).toBe(true);
    expect(lowQuote.key.currency0.toLowerCase()).toBe(QUOTE_LOW);
    expect(lowQuote.key.currency1.toLowerCase()).toBe(TOKEN);

    const highQuote = friarV2PoolKey(TOKEN, QUOTE_HIGH, 160);
    expect(highQuote.quoteIs0).toBe(false);
    expect(highQuote.key.currency0.toLowerCase()).toBe(TOKEN);
    expect(highQuote.key.currency1.toLowerCase()).toBe(QUOTE_HIGH);
  });

  it("spacing changes the PoolId; config/base fee do not live in the key", () => {
    const a = friarV2PoolKey(TOKEN, QUOTE_HIGH, 160).key;
    const b = friarV2PoolKey(TOKEN, QUOTE_HIGH, 100).key;
    expect(poolId(a)).not.toBe(poolId(b));
    // same pair + same spacing = same pool regardless of which preset opens it, which is
    // what makes "join don't fork" resolvable: the config is off-key.
    const again = friarV2PoolKey(TOKEN, QUOTE_HIGH, 160).key;
    expect(poolId(a)).toBe(poolId(again));
  });
});
