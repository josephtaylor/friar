#!/usr/bin/env node
// Recompute per-position aggregates (flow/fees/perf) and per-bin liquidity from the
// events table, and repair any positions/position_bins rows that drifted. The events
// table is the dedup'd source of truth (PK block+log_index); the aggregates were
// cumulative and double-applied whenever a block was replayed (eager ingest + cursor
// crawl) before indexer.ts got its applied-marker guard — position 13 shipped 2× fees
// and negative bin liquidity that way.
//
//   node scripts/repair-totals.mjs           dry run against REMOTE D1 (prints diffs)
//   node scripts/repair-totals.mjs --yes     apply the UPDATEs to REMOTE D1
//   add --local to target the local Miniflare D1 instead
//
// Runs wrangler from apps/indexer (that dir's wrangler.jsonc knows the friar D1).

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEXER_DIR = join(ROOT, "apps", "indexer");
const APPLY = process.argv.includes("--yes");
const TARGET = process.argv.includes("--local") ? "--local" : "--remote";

function d1(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "friar", TARGET, "--json", "--command", sql],
    { cwd: INDEXER_DIR, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  // wrangler --json emits an array of result sets (one per statement)
  const parsed = JSON.parse(out.slice(out.indexOf("[")));
  return parsed[0].results;
}

const events = d1(
  "SELECT position_id, name, data FROM events WHERE position_id IS NOT NULL ORDER BY block, log_index",
);
const positions = d1(
  "SELECT position_id, flow0, flow1, fees0, fees1, perf0, perf1 FROM positions",
);
const binRows = d1("SELECT position_id, bin_index, liquidity FROM position_bins");

// ---- recompute from events -------------------------------------------------
const totals = new Map(); // position_id -> {flow0,flow1,fees0,fees1,perf0,perf1}
const bins = new Map(); // position_id -> Map(bin_index -> liquidity)
const zero = () => ({ flow0: 0n, flow1: 0n, fees0: 0n, fees1: 0n, perf0: 0n, perf1: 0n });

for (const ev of events) {
  const id = ev.position_id;
  const a = JSON.parse(ev.data);
  const t = totals.get(id) ?? zero();
  totals.set(id, t);
  switch (ev.name) {
    case "PositionOpened": {
      const m = new Map();
      (a.bins ?? []).forEach((b, i) => m.set(i, BigInt(b.liquidity)));
      bins.set(id, m);
      break;
    }
    case "PositionIncreased":
    case "PositionDecreased": {
      const sign = ev.name === "PositionIncreased" ? 1n : -1n;
      const m = bins.get(id) ?? new Map();
      bins.set(id, m);
      (a.liquidityDeltas ?? []).forEach((d, i) => {
        if (BigInt(d) !== 0n) m.set(i, (m.get(i) ?? 0n) + sign * BigInt(d));
      });
      t.flow0 += BigInt(a.delta0 ?? 0);
      t.flow1 += BigInt(a.delta1 ?? 0);
      t.fees0 += BigInt(a.fees0 ?? 0);
      t.fees1 += BigInt(a.fees1 ?? 0);
      break;
    }
    case "FeesCollected": {
      t.flow0 += BigInt(a.delta0 ?? 0);
      t.flow1 += BigInt(a.delta1 ?? 0);
      t.fees0 += BigInt(a.fees0 ?? 0);
      t.fees1 += BigInt(a.fees1 ?? 0);
      break;
    }
    case "PerfFeeCharged": {
      t.perf0 += BigInt(a.perf0 ?? 0);
      t.perf1 += BigInt(a.perf1 ?? 0);
      break;
    }
  }
}

// ---- diff against the stored rows -------------------------------------------
const stmts = [];
const FIELDS = ["flow0", "flow1", "fees0", "fees1", "perf0", "perf1"];
for (const row of positions) {
  const want = totals.get(row.position_id);
  if (!want) continue; // no events indexed for it (shouldn't happen) — leave alone
  const drift = FIELDS.filter((f) => BigInt(row[f] ?? 0) !== want[f]);
  if (!drift.length) continue;
  console.log(`position ${row.position_id}: ${drift.map((f) => `${f} ${row[f]} -> ${want[f]}`).join(", ")}`);
  stmts.push(
    `UPDATE positions SET ${FIELDS.map((f) => `${f} = '${want[f]}'`).join(", ")} WHERE position_id = ${row.position_id};`,
  );
}
for (const row of binRows) {
  const want = bins.get(row.position_id)?.get(row.bin_index);
  if (want === undefined) continue;
  if (BigInt(row.liquidity) === want) continue;
  console.log(`position ${row.position_id} bin ${row.bin_index}: liquidity ${row.liquidity} -> ${want}`);
  stmts.push(
    `UPDATE position_bins SET liquidity = '${want}' WHERE position_id = ${row.position_id} AND bin_index = ${row.bin_index};`,
  );
}

if (!stmts.length) {
  console.log("no drift — nothing to repair");
  process.exit(0);
}
console.log(`\n${stmts.length} repair statement(s) for ${TARGET.slice(2)} D1`);
if (!APPLY) {
  console.log("dry run — re-run with --yes to apply");
  process.exit(0);
}
const file = join(mkdtempSync(join(tmpdir(), "friar-repair-")), "repair.sql");
writeFileSync(file, stmts.join("\n") + "\n");
execFileSync("npx", ["wrangler", "d1", "execute", "friar", TARGET, "--file", file], {
  cwd: INDEXER_DIR,
  stdio: "inherit",
});
console.log("applied ✓");
