import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi } from "viem";
import {
  ADDRESSES,
  friarPositionManagerAbi,
  friarPositionManagerV1ExitsAbi,
  MANAGERS,
  currentManager,
  robinhoodChain,
} from "@friar/chain";
import { getSqrtPriceAtTick } from "@friar/core";
import { planOpen } from "../src/plan.ts";
import {
  buildApprove,
  buildClose,
  buildCollect,
  buildDecrease,
  buildIncrease,
  buildOpen,
  disabledZap,
  proportionalDeltas,
} from "../src/tx.ts";
import type { PoolState } from "../src/types.ts";

const WETH = ADDRESSES.weth as `0x${string}`;
const TOKEN = "0xffffffffffffffffffffffffffffffffffffffff" as const;
const MANAGER = ADDRESSES.positionManager as `0x${string}`;

const liveState = (tick: number): PoolState => ({
  live: true,
  sqrtPriceX96: getSqrtPriceAtTick(tick) + 1n,
  tick,
  lpFee: 5000,
});

const plan = () =>
  planOpen(
    {
      token: TOKEN,
      quote: WETH,
      shape: "bidask",
      depthBelowPct: 15,
      depthAbovePct: 15,
      amountQuote: 5n * 10n ** 17n,
      amountBase: 5n * 10n ** 17n,
    },
    liveState(1234),
  );

describe("tx builders", () => {
  it("buildOpen encodes open() for a live pool and round-trips", () => {
    const p = plan();
    const tx = buildOpen(p);
    expect(tx.to).toBe(MANAGER);
    expect(tx.value).toBe(0n);
    expect(tx.chainId).toBe(robinhoodChain.id);

    const dec = decodeFunctionData({ abi: friarPositionManagerAbi, data: tx.data });
    expect(dec.functionName).toBe("open");
    const [key, bins, swapIn, maxPay0, maxPay1] = dec.args as unknown as [
      { currency0: string; tickSpacing: number },
      Array<{ tickLower: number; tickUpper: number; liquidity: bigint }>,
      { enabled: boolean },
      bigint,
      bigint,
    ];
    expect(key.currency0.toLowerCase()).toBe(p.key.currency0.toLowerCase());
    expect(bins.length).toBe(p.contractBins.length);
    expect(bins[0]!.liquidity).toBe(p.contractBins[0]!.liquidity);
    expect(swapIn.enabled).toBe(false);
    expect(maxPay0).toBe(p.maxPay0);
    expect(maxPay1).toBe(p.maxPay1);
  });

  it("buildOpen encodes openNew() with the init price for a dead pool", () => {
    const init = getSqrtPriceAtTick(-5000);
    const p = planOpen(
      {
        token: TOKEN,
        quote: WETH,
        shape: "spot",
        depthBelowPct: 10,
        depthAbovePct: 10,
        amountQuote: 10n ** 18n,
        amountBase: 10n ** 18n,
        initSqrtPriceX96: init,
      },
      { live: false, sqrtPriceX96: 0n, tick: 0, lpFee: 0 },
    );
    const dec = decodeFunctionData({ abi: friarPositionManagerAbi, data: buildOpen(p).data });
    expect(dec.functionName).toBe("openNew");
    expect((dec.args as unknown as [unknown, bigint])[1]).toBe(init);
  });

  it("buildIncrease / buildDecrease / buildClose / buildCollect round-trip", () => {
    const p = plan();
    const deltas = proportionalDeltas(p.contractBins, 2500n);

    const inc = decodeFunctionData({
      abi: friarPositionManagerAbi,
      data: buildIncrease(7n, deltas, { maxPay0: 1n, maxPay1: 2n, venue: p.key }).data,
    });
    expect(inc.functionName).toBe("increase");
    expect((inc.args as unknown as [bigint, bigint[]])[0]).toBe(7n);
    expect((inc.args as unknown as [bigint, bigint[]])[1]).toEqual(deltas);

    const dec = decodeFunctionData({
      abi: friarPositionManagerAbi,
      data: buildDecrease(7n, deltas, { venue: p.key, minReceive0: 3n }).data,
    });
    expect(dec.functionName).toBe("decrease");
    expect((dec.args as unknown as [bigint, bigint[], { enabled: boolean }, bigint])[3]).toBe(3n);

    const close = decodeFunctionData({
      abi: friarPositionManagerAbi,
      data: buildClose(9n, { venue: p.key }).data,
    });
    expect(close.functionName).toBe("close");

    const col = decodeFunctionData({
      abi: friarPositionManagerAbi,
      data: buildCollect(9n, { venue: p.key, zap: { ...disabledZap(p.key), enabled: true, zeroForOne: true } }).data,
    });
    expect(col.functionName).toBe("collect");
    expect((col.args as unknown as [bigint, { enabled: boolean; zeroForOne: boolean }])[1].enabled).toBe(true);
  });

  it("buildApprove targets the token and approves the manager", () => {
    const tx = buildApprove(WETH, 123n);
    expect(tx.to).toBe(WETH);
    const dec = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(dec.functionName).toBe("approve");
    expect(dec.args).toEqual([MANAGER, 123n]);
  });

  it("proportionalDeltas scales bins and validates bps", () => {
    const bins = [{ tickLower: 0, tickUpper: 100, liquidity: 1000n }];
    expect(proportionalDeltas(bins, 5000n)).toEqual([500n]);
    expect(proportionalDeltas(bins, 10_000n)).toEqual([1000n]);
    expect(() => proportionalDeltas(bins, 0n)).toThrow();
    expect(() => proportionalDeltas(bins, 10_001n)).toThrow();
  });
});

describe("exit pay caps", () => {
  const venue = () => plan().key;

  /** An exit must never be able to charge the owner by default. Without this cap a zap
   * venue whose hook returns an unbounded swap delta drains the manager's allowance. */
  it("close / collect / decrease default maxPay0 and maxPay1 to zero", () => {
    const cases = [
      buildClose(1n, { venue: venue() }).data,
      buildCollect(1n, { venue: venue() }).data,
      buildDecrease(1n, [1n], { venue: venue() }).data,
    ];
    for (const data of cases) {
      const d = decodeFunctionData({ abi: friarPositionManagerAbi, data });
      const args = d.args as unknown as readonly bigint[];
      expect(args[args.length - 2]).toBe(0n); // maxPay0
      expect(args[args.length - 1]).toBe(0n); // maxPay1
    }
  });

  it("caps can be raised deliberately to escape a pool that charges on exit", () => {
    const d = decodeFunctionData({
      abi: friarPositionManagerAbi,
      data: buildClose(1n, { venue: venue(), maxPay0: 5n, maxPay1: 9n }).data,
    });
    const args = d.args as unknown as readonly bigint[];
    expect(args[args.length - 2]).toBe(5n);
    expect(args[args.length - 1]).toBe(9n);
  });
});

describe("multi-manager exits", () => {
  const venue = () => plan().key;
  const v1 = MANAGERS.find((m) => m.exitAbi === "v1");
  const v2 = MANAGERS.find((m) => m.exitAbi === "v2");

  /** Managers are immutable: an exit must go to the contract the position was OPENED on,
   * or a redeploy strands everyone who didn't close first. */
  it("targets the position's own manager, not the current one", () => {
    if (!v1) return;
    for (const t of [
      buildClose(5n, { venue: venue(), manager: v1 }),
      buildCollect(5n, { venue: venue(), manager: v1 }),
      buildDecrease(5n, [1n], { venue: venue(), manager: v1 }),
    ]) {
      expect(t.to.toLowerCase()).toBe(v1.address.toLowerCase());
    }
  });

  it("encodes the legacy 4-arg exit for a v1 manager (no pay caps on that contract)", () => {
    if (!v1) return;
    const d = decodeFunctionData({
      abi: friarPositionManagerV1ExitsAbi,
      data: buildClose(5n, { venue: venue(), manager: v1 }).data,
    });
    expect(d.functionName).toBe("close");
    expect(d.args).toHaveLength(4);
  });

  it("encodes the 6-arg exit for a v2 manager", () => {
    if (!v2) return;
    const d = decodeFunctionData({
      abi: friarPositionManagerAbi,
      data: buildClose(11n, { venue: venue(), manager: v2 }).data,
    });
    expect(d.functionName).toBe("close");
    expect(d.args).toHaveLength(6);
  });

  /** The two generations must not share a selector, or a v1 call could be silently
   * accepted by a v2 contract (and vice versa) with misread arguments. */
  it("v1 and v2 exit selectors are distinct", () => {
    if (!v1 || !v2) return;
    const a = buildClose(5n, { venue: venue(), manager: v1 }).data.slice(0, 10);
    const b = buildClose(11n, { venue: venue(), manager: v2 }).data.slice(0, 10);
    expect(a).not.toBe(b);
  });

  it("defaults to the current manager when none is given", () => {
    expect(buildClose(11n, { venue: venue() }).to.toLowerCase()).toBe(currentManager().address.toLowerCase());
  });
});
