#!/usr/bin/env node
// The dynamic fee, drawn: base while calm, surging with realised volatility, decaying back.
//
//   node apps/site/scripts/make-fee-curve-png.mjs [outPath] [--scale=2] [--format=svg]
//
// The curve is SIMULATED WITH THE REAL MATH, not drawn freehand. It runs the same volatility
// accumulator the hook runs (FriarMath, mirrored in notes/harness/fee-replay.mjs) over a
// synthetic price path, with the deployed standard parameters:
//
//   baseFactor 5000, filterPeriod 10s, decayPeriod 600s, reductionFactor 5000,
//   variableFeeControl 40000, maxVolatilityAccumulator 350000, tickSpacing 160
//
// so the shape of the spike and the shape of the decay are both properties of the mechanism
// rather than of my drawing hand. Change a parameter here and the picture changes correctly.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, Resvg } from "@resvg/resvg-wasm";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "../../api/src/assets");
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? Number(hit.split("=")[1]) : d;
};
const out = process.argv[2]?.startsWith("--") ? undefined : process.argv[2];
const OUT = out ?? join(here, "../../../../notes/launch-assets/friar-fee-curve.png");
const SCALE = arg("scale", 2);

const BG = "#100c07", PANEL = "#181209", BORDER = "#2a2012", BORDER_HI = "#463620";
const TEXT = "#ece3d2", DIM = "#8a7a5f", FAINT = "#5d5138";
const ACCENT = "#cf9440", GREEN = "#8fbf5f", RED = "#e05d52";
const W = 1600, H = 900, M = 64;
const SANS = "IBM Plex Sans", MONO = "IBM Plex Mono";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const t = (x, y, s, { size = 20, fill = TEXT, font = SANS, weight = 400, anchor = "middle", ls = 0 } = {}) =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}"${ls ? ` letter-spacing="${ls}"` : ""}>${esc(s)}</text>`;

// ---- the actual mechanism (BigInt, same units as the contract) ---------------------------
const BP_MAX = 10_000n, MAX_FEE_1E18 = 10n ** 17n, PIPS = 10n ** 12n;
const P = { baseFactor: 5000n, filter: 10, decay: 600, reduction: 5000n, vfc: 40_000n, maxVa: 350_000n };
const BIN_STEP = 160;

function feePips(va) {
  const base = P.baseFactor * BigInt(BIN_STEP) * 10n ** 10n;
  const prod = va * BigInt(BIN_STEP);
  const variable = (prod * prod * P.vfc + 99n) / 100n;
  const fee = base + variable > MAX_FEE_1E18 ? MAX_FEE_1E18 : base + variable;
  return Number(fee / PIPS); // pips, 10000 = 1%
}

// The accumulator updates PER SWAP, not per second, and the filter period compares the gap
// BETWEEN swaps. A first draft stepped one second at a time, so dt was always 1, the 10s
// filter never fired, the reference never re-anchored and the fee pinned at the cap forever.
// The schedule matters as much as the maths, so this models one:
//
//   quiet   swaps ~every 30s   → dt > filter, so each one re-anchors and halves the score
//   burst   swaps ~every 2s    → dt < filter, so the score accumulates the whole move
//
// That is what produces the real shape: flat at base, a near-vertical spike, then a staircase
// down as each quiet swap applies the 50% reduction.
const DURATION = 900;
const swaps = [];
for (let s = 0; s < 180; s += 30) swaps.push({ s, bucket: 0 }); // calm
for (let s = 180; s <= 240; s += 2) swaps.push({ s, bucket: Math.round(((s - 180) / 60) * 25) }); // the move
for (let s = 270; s <= DURATION; s += 30) swaps.push({ s, bucket: 25 }); // quiet again, new level

let va = 0n, vr = 0n, ref = 0, last = 0;
const series = swaps.map(({ s, bucket }) => {
  const dt = s - last;
  if (dt >= P.filter) {
    ref = bucket;
    vr = dt < P.decay ? (va * P.reduction) / BP_MAX : 0n;
  }
  last = s;
  const raw = vr + BigInt(Math.abs(bucket - ref)) * BP_MAX;
  va = raw > P.maxVa ? P.maxVa : raw;
  return { s, pips: feePips(va) };
});

// ---- plot -------------------------------------------------------------------------------
const PX = M + 78, PY = 300, PW = W - M - PX, PH = 420;
const CAP = 100_000; // 10% in pips
const x = (s) => PX + (s / DURATION) * PW;
const y = (pips) => PY + PH - (pips / CAP) * PH;

const grid = [
  [100_000, "10%  cap"],
  [50_000, "5%"],
  [30_000, "3%"],
  [10_000, "1%"],
  [0, "0%"],
]
  .map(
    ([pips, label]) =>
      `<line x1="${PX}" y1="${y(pips).toFixed(1)}" x2="${PX + PW}" y2="${y(pips).toFixed(1)}" stroke="${BORDER}"/>
       ${t(PX - 16, y(pips) + 6, label, { size: 17, fill: pips === CAP ? RED : DIM, font: MONO, anchor: "end" })}`,
  )
  .join("");

// step, not smooth: the fee is constant between swaps
const line = series
  .map((p, i) =>
    i === 0
      ? `M${x(p.s).toFixed(1)},${y(p.pips).toFixed(1)}`
      : `L${x(p.s).toFixed(1)},${y(series[i - 1].pips).toFixed(1)} L${x(p.s).toFixed(1)},${y(p.pips).toFixed(1)}`,
  )
  .join(" ");
const area = `${line} L${x(DURATION).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
const peak = series.reduce((a, b) => (b.pips > a.pips ? b : a));
const base = feePips(0n);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${ACCENT}" stop-opacity="0.34"/>
      <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0.02"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${BG}"/>

  ${t(M, 78, "FRIAR", { size: 32, fill: ACCENT, font: MONO, weight: 600, anchor: "start", ls: 9 })}
  ${t(W - M, 76, "THE DYNAMIC FEE", { size: 17, fill: DIM, font: MONO, anchor: "end", ls: 3 })}
  <line x1="${M}" y1="108" x2="${W - M}" y2="108" stroke="${BORDER}"/>
  ${t(M, 172, "The fee reprices on every swap", { size: 46, fill: TEXT, weight: 600, anchor: "start" })}
  ${t(M, 214, "Low while the market is calm, climbing with how far price has just moved, decaying back when it", { size: 21, fill: DIM, anchor: "start" })}
  ${t(M, 242, "stops. The dashed line marks 1%, a common static fee tier, for scale.", { size: 21, fill: DIM, anchor: "start" })}

  ${grid}

  <!-- the 1% gridline, drawn dashed, as a familiar reference height -->
  <line x1="${PX}" y1="${y(10_000).toFixed(1)}" x2="${PX + PW}" y2="${y(10_000).toFixed(1)}" stroke="${DIM}" stroke-width="2" stroke-dasharray="7 6"/>
  ${t(PX + PW, y(10_000) - 14, "1% static tier", { size: 18, fill: DIM, font: MONO, anchor: "end" })}

  <path d="${area}" fill="url(#fill)"/>
  <path d="${line}" fill="none" stroke="${ACCENT}" stroke-width="3" stroke-linejoin="round"/>

  <!-- annotations -->
  ${t(x(90), y(base) - 22, "calm: 0.80% base", { size: 18, fill: DIM, font: MONO })}
  <circle cx="${x(peak.s).toFixed(1)}" cy="${y(peak.pips).toFixed(1)}" r="6" fill="${ACCENT}"/>
  ${t(x(peak.s) + 22, y(peak.pips) + 34, "price runs → fee hits the 10% cap", { size: 19, fill: TEXT, font: MONO, anchor: "start" })}
  ${t(x(430), y(26_000), "each quiet swap halves the surge", { size: 18, fill: DIM, font: MONO, anchor: "start" })}

  <line x1="${PX}" y1="${PY + PH}" x2="${PX + PW}" y2="${PY + PH}" stroke="${BORDER_HI}"/>
  ${t(PX, PY + PH + 34, "0", { size: 17, fill: FAINT, font: MONO, anchor: "start" })}
  ${t(PX + PW / 2, PY + PH + 34, "time →   (about 15 minutes)", { size: 17, fill: FAINT, font: MONO })}
  ${t(PX + PW, PY + PH + 34, "15m", { size: 17, fill: FAINT, font: MONO, anchor: "end" })}

  <!-- the parameters that produced this curve -->
  ${t(M, H - 118, "standard hook · baseFactor 5000 · filterPeriod 10s · decayPeriod 600s · reductionFactor 50% · variableFeeControl 40000 · cap 10%", { size: 17, fill: FAINT, font: MONO, anchor: "start" })}
  ${t(M, H - 92, "base fee = baseFactor × tickSpacing, so 0.80% at the 160 spacing this curve uses", { size: 17, fill: FAINT, font: MONO, anchor: "start" })}

  <line x1="${M}" y1="${H - 74}" x2="${W - M}" y2="${H - 74}" stroke="${BORDER}"/>
  ${t(M, H - 36, "friar.fi", { size: 22, fill: ACCENT, font: MONO, anchor: "start", ls: 2 })}
  ${t(W - M, H - 36, "Robinhood Chain · 4663", { size: 19, fill: FAINT, font: MONO, anchor: "end" })}
</svg>`;

if (process.argv.includes("--format=svg")) {
  writeFileSync(OUT.replace(/\.png$/, ".svg"), svg);
  console.log(`wrote ${OUT.replace(/\.png$/, ".svg")} — ${(svg.length / 1024).toFixed(0)} KB of SVG`);
} else {
  await initWasm(readFileSync(fileURLToPath(import.meta.resolve("@resvg/resvg-wasm/index_bg.wasm"))));
  const fonts = ["IBMPlexMono-Regular", "IBMPlexMono-SemiBold", "IBMPlexSans-Regular", "IBMPlexSans-SemiBold"].map(
    (f) => new Uint8Array(readFileSync(join(assets, `${f}.ttf`))),
  );
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: W * SCALE },
    font: { fontBuffers: fonts, defaultFontFamily: SANS, loadSystemFonts: false },
  }).render().asPng();
  writeFileSync(OUT, png);
  console.log(`wrote ${OUT} — ${W * SCALE}x${H * SCALE}, ${(png.length / 1024).toFixed(0)} KB`);
}
