import { test, expect } from "vitest";
import { ADDRESSES, FEE_TIERS } from "@friar/chain";
import { enrichToken, friarBaseFeePips, friarFloorPips, selectFriarPools, type FriarPoolRow } from "../src/friarpools.js";

const WETH = ADDRESSES.weth;
const TOKEN = "0x232CDFc415D10b673845D83Dc02ba2eaBe7e30d1"; // mixed case on purpose
const tierHook = (pct: number) => FEE_TIERS.find((t) => t.pct === pct)!.hook!;

const row = (over: Partial<FriarPoolRow>): FriarPoolRow => ({
  pool_id: "0xpool",
  currency0: WETH,
  currency1: TOKEN,
  hooks: ADDRESSES.friarStandard,
  tick_spacing: 100,
  open_n: 0,
  ...over,
});

test("V1 hooks derive base fee from spacing; tier hooks carry it; others are not ours", () => {
  expect(friarBaseFeePips(ADDRESSES.friarStandard, 100)).toBe(5_000);
  expect(friarBaseFeePips(ADDRESSES.friarCalm, 160)).toBe(8_000);
  expect(friarBaseFeePips(tierHook(1), 100)).toBe(10_000);
  expect(friarBaseFeePips(tierHook(5), 20)).toBe(50_000);
  expect(friarBaseFeePips("0x0000000000000000000000000000000000000000", 100)).toBeNull();
  expect(friarBaseFeePips("0x1234567890123456789012345678901234567890", 100)).toBeNull();
});

test("the floor is the cheapest deployed tier", () => {
  expect(friarFloorPips()).toBe(3_000);
});

test("a live tier pool beats an empty V1 pool on the same token (the IF regression)", () => {
  const { byToken } = selectFriarPools([
    row({ pool_id: "0xlegacy", hooks: ADDRESSES.friarStandard, open_n: 0 }),
    row({ pool_id: "0xtier", hooks: tierHook(1), open_n: 1 }),
  ]);
  const pick = byToken.get(TOKEN.toLowerCase())!.WETH!;
  expect(pick.poolId).toBe("0xtier");
  expect(pick.baseFee).toBe(10_000);
});

test("selection order: live beats empty, then tier generation beats V1", () => {
  const legacyLive = row({ pool_id: "0xlegacyLive", hooks: ADDRESSES.friarStandard, open_n: 3 });
  const tierEmpty = row({ pool_id: "0xtierEmpty", hooks: tierHook(2), open_n: 0 });
  // live V1 vs empty tier → the live pool wins regardless of generation
  expect(selectFriarPools([legacyLive, tierEmpty]).byToken.get(TOKEN.toLowerCase())!.WETH!.poolId).toBe("0xlegacyLive");
  // both empty → the tier pool wins
  const legacyEmpty = row({ pool_id: "0xlegacyEmpty", open_n: 0 });
  expect(selectFriarPools([legacyEmpty, tierEmpty]).byToken.get(TOKEN.toLowerCase())!.WETH!.poolId).toBe("0xtierEmpty");
  // both live tiers → more open positions wins
  const tierBusy = row({ pool_id: "0xtierBusy", hooks: tierHook(5), open_n: 4 });
  const tierQuiet = row({ pool_id: "0xtierQuiet", hooks: tierHook(1), open_n: 1 });
  expect(selectFriarPools([tierQuiet, tierBusy]).byToken.get(TOKEN.toLowerCase())!.WETH!.poolId).toBe("0xtierBusy");
});

test("ids cover every Friar generation and exclude foreign hooks", () => {
  const { ids, byToken } = selectFriarPools([
    row({ pool_id: "0xV1", hooks: ADDRESSES.friarStandard }),
    row({ pool_id: "0xV2", hooks: ADDRESSES.friarV2 }),
    row({ pool_id: "0xT", hooks: tierHook(0.3) }),
    row({ pool_id: "0xDoppler", hooks: "0x1234567890123456789012345678901234567890" }),
  ]);
  expect(ids).toEqual(new Set(["0xv1", "0xv2", "0xt"]));
  // the foreign-hook pool must not become the board pointer either
  expect(byToken.get(TOKEN.toLowerCase())!.WETH!.poolId).not.toBe("0xDoppler");
});

test("enrichToken quotes the picked pool's fee and undercuts against it", () => {
  const { byToken } = selectFriarPools([row({ pool_id: "0xtier", hooks: tierHook(1), open_n: 1 })]);
  const t = { address: TOKEN.toLowerCase(), quote: "WETH", incumbent_fee: 10_000 };
  const e = enrichToken(t, byToken);
  expect(e.friarPoolId).toBe("0xtier");
  expect(e.friarBaseFee).toBe(10_000);
  expect(e.undercutsIncumbent).toBe(false); // 1% does not undercut a 1% incumbent
});

test("without a Friar pool the floor is quoted; cross-rail pools still count", () => {
  const none = enrichToken({ address: TOKEN.toLowerCase(), quote: "WETH", incumbent_fee: 10_000 }, new Map());
  expect(none.friarPoolId).toBeNull();
  expect(none.friarBaseFee).toBe(3_000);
  expect(none.undercutsIncumbent).toBe(true);
  expect(none.friarPoolId).toBeNull();

  const usdgPool = selectFriarPools([row({ pool_id: "0xusdg", currency0: ADDRESSES.usdg, hooks: tierHook(1) })]);
  const cross = enrichToken({ address: TOKEN.toLowerCase(), quote: "WETH", incumbent_fee: null }, usdgPool.byToken);
  expect(cross.friarPoolId).toBe("0xusdg");
  expect(cross.undercutsIncumbent).toBeNull();
});
