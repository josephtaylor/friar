import { describe, it, expect } from "vitest";
import { aggregatePairs, railFor, railPairFor, ADDRESSES, type DsPair, type RwaAsset } from "../src/index.ts";

const WETH = ADDRESSES.weth;
const USDG = ADDRESSES.usdg;
const TOKEN = "0x1111111111111111111111111111111111111111";

function pair(over: Partial<DsPair> & { pairAddress: string }): DsPair {
  return {
    chainId: "robinhood",
    baseToken: { address: TOKEN, symbol: "TKN" },
    quoteToken: { address: WETH },
    priceNative: "1",
    ...over,
  } as DsPair;
}

describe("aggregatePairs", () => {
  it("sums volume and liquidity across a token's pairs and counts them", () => {
    const out = aggregatePairs(
      [
        pair({ pairAddress: "0xa", volume: { h24: 100, h1: 1, h6: 10 }, liquidity: { usd: 1000 } }),
        pair({ pairAddress: "0xb", volume: { h24: 50, h1: 2, h6: 5 }, liquidity: { usd: 500 } }),
      ],
      new Map(),
    );
    const t = out[TOKEN.toLowerCase()]!;
    expect(t.vol).toBe(150);
    expect(t.vol1).toBe(3);
    expect(t.vol6).toBe(15);
    expect(t.liq).toBe(1500);
    expect(t.pools).toBe(2);
  });

  // Market cap is a property of the token, not of any one pool, so summing it would
  // multiply the token's own value by how many venues happen to list it.
  it("takes the max market cap rather than summing it, and falls back to fdv", () => {
    const out = aggregatePairs(
      [
        pair({ pairAddress: "0xa", marketCap: 900, liquidity: { usd: 10 } }),
        pair({ pairAddress: "0xb", fdv: 1200, liquidity: { usd: 10 } }),
      ],
      new Map(),
    );
    expect(out[TOKEN.toLowerCase()]!.mcap).toBe(1200);
  });

  // A thin pool's print is noise; the deepest pool is the reliable one.
  it("takes price and price-action from the deepest pool", () => {
    const out = aggregatePairs(
      [
        pair({ pairAddress: "0xthin", liquidity: { usd: 1 }, priceNative: "999", priceUsd: "999", priceChange: { h24: -90 } }),
        pair({ pairAddress: "0xdeep", liquidity: { usd: 100_000 }, priceNative: "2", priceUsd: "7", priceChange: { h24: 12 } }),
      ],
      new Map(),
    );
    const t = out[TOKEN.toLowerCase()]!;
    expect(t.priceNative).toBe(2);
    expect(t.priceUsd).toBe(7);
    expect(t.ch24).toBe(12);
  });

  // WETH and USDG are how everything else is priced; they are not themselves LP targets.
  it("never folds a quote rail into a token of its own", () => {
    const out = aggregatePairs(
      [
        pair({ pairAddress: "0xa", baseToken: { address: WETH, symbol: "WETH" }, quoteToken: { address: USDG } }),
        pair({ pairAddress: "0xb", baseToken: { address: USDG, symbol: "USDG" }, quoteToken: { address: WETH } }),
      ],
      new Map(),
    );
    expect(Object.keys(out)).toHaveLength(0);
  });

  it("keeps only rail-quoted pairs as incumbent candidates, deepest first", () => {
    const out = aggregatePairs(
      [
        pair({ pairAddress: "0xshallow", liquidity: { usd: 10 } }),
        pair({ pairAddress: "0xdeep", liquidity: { usd: 999 }, quoteToken: { address: USDG } }),
        // quoted in some other token — not a rail, so not a venue we compare against
        pair({ pairAddress: "0xodd", liquidity: { usd: 5000 }, quoteToken: { address: TOKEN } }),
        // a rail pair with no usable price can't anchor anything
        pair({ pairAddress: "0xnoprice", liquidity: { usd: 5000 }, priceNative: "0" }),
      ],
      new Map(),
    );
    const t = out[TOKEN.toLowerCase()]!;
    expect(t.railPairs.map((p) => p.address)).toEqual(["0xdeep", "0xshallow"]);
    expect(t.railPairs[0]!.quote).toBe("USDG");
  });

  it("treats native ETH as a WETH rail — a native-quoted venue is the same market", () => {
    const NATIVE = "0x0000000000000000000000000000000000000000";
    const out = aggregatePairs(
      [
        // the dominant native-quoted venue must outrank the WETH satellite for incumbency
        pair({ pairAddress: "0xnative", liquidity: { usd: 2_850_000 }, quoteToken: { address: NATIVE } }),
        pair({ pairAddress: "0xwethsat", liquidity: { usd: 57_000 } }),
        // and native ETH itself must never become a board token
        pair({ pairAddress: "0xethusdg", baseToken: { address: NATIVE, symbol: "ETH" }, quoteToken: { address: USDG } }),
      ],
      new Map(),
    );
    expect(Object.keys(out)).toEqual([TOKEN.toLowerCase()]);
    const t = out[TOKEN.toLowerCase()]!;
    expect(t.railPairs.map((p) => p.address)).toEqual(["0xnative", "0xwethsat"]);
    expect(t.railPairs[0]!.quote).toBe("WETH");
  });

  it("classifies a registry token as rwa and takes its metadata over Dexscreener's", () => {
    const reg: RwaAsset = { addr: TOKEN, sym: "NVDA", name: "NVIDIA", logo: "https://x/logo.png" };
    const out = aggregatePairs(
      [pair({ pairAddress: "0xa", liquidity: { usd: 10 }, quoteToken: { address: USDG } })],
      new Map([[TOKEN.toLowerCase(), reg]]),
    );
    const t = out[TOKEN.toLowerCase()]!;
    expect(t.kind).toBe("rwa");
    expect(t.sym).toBe("NVDA");
    expect(t.name).toBe("NVIDIA");
    expect(railFor(t)).toBe("USDG");
  });

  it("reports NO rail rather than defaulting to WETH — the default was a lie", () => {
    // INTISMERAN trades $2.6M/day quoted in mrna and has no WETH pool at all. The old
    // default folded it to a row reading quote "WETH" whose price_native was denominated
    // in MRNA, so anything that trusted the pair would have sized off a price ~1/200th of
    // the truth. A caller that cannot say what a token is denominated in must refuse it.
    const out = aggregatePairs([pair({ pairAddress: "0xa", quoteToken: { address: TOKEN } })], new Map());
    expect(railFor(out[TOKEN.toLowerCase()]!)).toBeNull();
    expect(railPairFor(out[TOKEN.toLowerCase()]!)).toBeNull();
  });

  it("treats a STOCK token as a rail — this is how Pons pairs become reachable", () => {
    const STOCK = "0xd95b44124e475743a7589e68f3d74008a5536d44";
    const reg = new Map([[STOCK, { addr: STOCK, sym: "CRM", name: "Salesforce", logo: null }]]);
    const out = aggregatePairs([pair({ pairAddress: "0xa", quoteToken: { address: STOCK } })], reg);
    const t = out[TOKEN.toLowerCase()]!;
    expect(railFor(t)).toBe("CRM");
    expect(railPairFor(t)!.quoteAddr).toBe(STOCK);
  });
});
