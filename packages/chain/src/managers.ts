import type { Address } from "viem";

/**
 * Every FriarPositionManager the product still needs to talk to.
 *
 * The manager is not upgradeable by design, so shipping a new version means deploying a
 * new contract — and users cannot be forced to drain their positions to make that
 * possible. So the stack stays manager-AWARE rather than pinned to one address: positions
 * record which manager they live on, the indexer watches all of them, and the UI exits
 * each position against its own contract with its own ABI. Retired managers keep working
 * forever; they simply stop receiving new opens.
 *
 * Position ids are a single global namespace across managers (D1 keys `positions` by id
 * alone), which is why each deployment takes a `startingPositionId` above the previous
 * one's high-water mark. Never restart ids at 1.
 *
 * The original flat-fee manager (0xD3EE78a76C4C660EC3d25244855A8423a37Db110, retired
 * 2026-07-23) is deliberately absent: every position on it was closed before the cutover
 * and none was ever indexed, so listing it would only make a reindex scan dead blocks.
 */
export interface ManagerDeployment {
  address: Address;
  /** First block containing this manager's logs — the indexer's floor for it. */
  deployBlock: number;
  /**
   * Exit-verb ABI generation. v1 exits take (id, zap, minReceive0, minReceive1); v2 adds
   * (maxPay0, maxPay1) so a hostile zap venue cannot settle a debt from the owner's
   * wallet. The arg count is the only shape difference between generations.
   */
  exitAbi: "v1" | "v2";
  /**
   * The perf fee this manager charges, in percent, taken in-kind on fees earned at
   * collection (principal is never touched). `tiered` splits on bin count (single-bin
   * "simple" vs multi-bin "shaped"); `flat` is one rate for both. Drives user-facing fee
   * copy so it stays correct across the cutover instead of being hardcoded to one manager.
   */
  feeModel: { kind: "tiered"; simplePct: number; shapedPct: number } | { kind: "flat"; pct: number };
  /** Exactly one manager accepts new opens; the rest are exit-only. */
  current: boolean;
  label: string;
}

/** User-facing perf-fee sentence for a manager and open style. Single source so the open
 *  preview, docs blurbs, and any fee disclosure read identically. */
export function perfFeeCopy(m: ManagerDeployment, simple: boolean): string {
  const tail = "charged on-chain at collection. Principal is never touched.";
  if (m.feeModel.kind === "flat") return `${m.feeModel.pct}% fee on fees earned — ${tail}`;
  return simple
    ? `${m.feeModel.simplePct}% fee on fees earned (simple tier) — ${tail}`
    : `${m.feeModel.shapedPct}% performance fee on fees earned (shaped tier) — ${tail}`;
}

export const MANAGERS: readonly ManagerDeployment[] = [
  {
    address: "0x0e9064622c6AD90d9ADfFcd1E203df52cC870cb3",
    deployBlock: 17_526_841,
    exitAbi: "v1",
    feeModel: { kind: "tiered", simplePct: 1, shapedPct: 10 },
    current: false,
    label: "tiered fee",
  },
  {
    // Adds maxPay0/maxPay1 to decrease/close/collect (a zap venue's hook could otherwise
    // return an unbounded swap delta and make an exit settle a debt from the owner's
    // wallet), and fixes multi-bin positions bricking once a single bin was emptied.
    address: "0x49a1e3A9Ff7b11c007914dB386518e78DE60c5DC",
    deployBlock: 20_714_167,
    exitAbi: "v2",
    feeModel: { kind: "tiered", simplePct: 1, shapedPct: 10 },
    current: false,
    label: "exit pay caps",
  },
  {
    // Flat 5% both tiers, retiring the 10%-shaped/1%-simple split: measured over 21 real
    // positions the blended take was 6.0% and the tiers showed no yield difference once
    // controlled for time, so the split mostly taught users to optimise bins.length.
    //
    // Exemptions moved OUT of the manager into a shared FeeExemptionRegistry, so the list
    // survives redeploys instead of silently resetting.
    //
    // Current since 2026-08-01 (staged 07-31; the flip was purely a pricing change,
    // decoupled from the FriarTier hooks). Hook-agnostic like every manager
    // (open()/openNew() take any PoolKey); its openNewConfigured verb goes unused under
    // the tier model (base fee is in the hook, not config), which is harmless.
    //
    // Not gated on the Uniswap hooklist: quoting comes from Uniswap's ROUTING allowlist,
    // which auto-allowlists the Friar hooks (no delta flag, not 0x91, not major-pair — the
    // same test the V1 hooks pass, which is why they already receive Universal Router flow).
    // The public hooklist is a metadata registry the router ignores.
    address: "0xBd76176c5524785452D80c4350f18e3A2040470E",
    deployBlock: 23_848_136,
    exitAbi: "v2",
    feeModel: { kind: "flat", pct: 5 },
    current: true,
    label: "flat 5% + shared exemptions",
  },
] as const;

/** The manager that accepts new opens. */
export function currentManager(): ManagerDeployment {
  const m = MANAGERS.find((x) => x.current);
  if (!m) throw new Error("no current FriarPositionManager configured");
  return m;
}

/** Look a manager up by address (case-insensitive). Unknown addresses return undefined. */
export function managerFor(address: string | null | undefined): ManagerDeployment | undefined {
  if (!address) return undefined;
  const a = address.toLowerCase();
  return MANAGERS.find((m) => m.address.toLowerCase() === a);
}

/**
 * Resolve the manager for a position row. Rows written before `positions.manager` existed
 * predate multi-manager support, so they belong to the oldest deployment listed.
 */
export function managerForPosition(row: { manager?: string | null }): ManagerDeployment {
  return managerFor(row.manager) ?? MANAGERS[0]!;
}

/** Lowest deploy block across all managers — where a full reindex must start. */
export function earliestManagerBlock(): number {
  return Math.min(...MANAGERS.map((m) => m.deployBlock));
}

/** All manager addresses, for log filters. */
export function managerAddresses(): Address[] {
  return MANAGERS.map((m) => m.address);
}
