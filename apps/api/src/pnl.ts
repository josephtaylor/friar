// Position PnL summary from indexed rows. Pure — unit-testable.
//
// Model: pnl = value(current holdings) + value(net cash flows), quote-denominated at
// the chosen price (true market when available). Fees enter net of the perf fee; inventory
// delta is the remainder — the fees-vs-inventory decomposition the product leads with.
import { markPrice1e18 } from "@friar/core";

export interface PositionRow {
  position_id: number;
  owner: string;
  pool_id: string;
  opened_ts: number;
  closed_ts: number | null;
  open_delta0: string;
  open_delta1: string;
  flow0: string;
  flow1: string;
  fees0: string;
  fees1: string;
  perf0: string;
  perf1: string;
}

export interface SnapshotRow {
  ts: number;
  sqrt_price: string;
  market_sqrt_price: string | null;
  amount0: string;
  amount1: string;
  fees0: string;
  fees1: string;
}

export interface PnlSummary {
  /** quote-denominated, decimal strings (1e18-scale of the quote token) */
  valueQuote: string;
  cashflowQuote: string;
  pnlQuote: string;
  feesNetQuote: string;
  inventoryQuote: string;
  perfFeeQuote: string;
  investedQuote?: string;
  unclaimedFees0: string;
  unclaimedFees1: string;
  priceUsed: string;
  markedAt: number | null;
}

const E18 = 10n ** 18n;

export function summarizePosition(row: PositionRow, snap: SnapshotRow | null, quoteIs0: boolean): PnlSummary {
  const sqrt = snap ? BigInt(snap.market_sqrt_price ?? snap.sqrt_price) : 0n;
  // markPrice1e18, not price1e18: a pool pinned at a swap limit has no usable price, and
  // the 0n it returns takes the same "unpriceable" branch as a missing snapshot (quote leg
  // only). See markPrice1e18 for the FLAMINGO #284 case that made this necessary.
  const px = sqrt > 0n ? markPrice1e18(sqrt) : 0n;
  const val = (a0: bigint, a1: bigint): bigint =>
    px === 0n ? (quoteIs0 ? a0 : a1) : quoteIs0 ? a0 + (a1 * E18) / px : a1 + (a0 * px) / E18;

  const holdings0 = snap ? BigInt(snap.amount0) + BigInt(snap.fees0) : 0n;
  const holdings1 = snap ? BigInt(snap.amount1) + BigInt(snap.fees1) : 0n;
  const cash0 = BigInt(row.open_delta0) + BigInt(row.flow0);
  const cash1 = BigInt(row.open_delta1) + BigInt(row.flow1);

  const valueQuote = val(holdings0, holdings1);
  const cashflowQuote = val(cash0, cash1);
  const pnlQuote = valueQuote + cashflowQuote;

  const perfFeeQuote = val(BigInt(row.perf0), BigInt(row.perf1));
  // gross fees from events + unclaimed from snapshot, minus the perf fee = what the LP keeps
  const feesNetQuote =
    val(BigInt(row.fees0), BigInt(row.fees1)) + val(snap ? BigInt(snap.fees0) : 0n, snap ? BigInt(snap.fees1) : 0n) - perfFeeQuote;
  const inventoryQuote = pnlQuote - feesNetQuote;

  return {
    valueQuote: valueQuote.toString(),
    cashflowQuote: cashflowQuote.toString(),
    pnlQuote: pnlQuote.toString(),
    feesNetQuote: feesNetQuote.toString(),
    inventoryQuote: inventoryQuote.toString(),
    perfFeeQuote: perfFeeQuote.toString(),
    unclaimedFees0: snap ? snap.fees0 : "0",
    unclaimedFees1: snap ? snap.fees1 : "0",
    priceUsed: px.toString(),
    markedAt: snap ? snap.ts : null,
  };
}
