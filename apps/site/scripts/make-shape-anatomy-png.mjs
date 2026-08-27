#!/usr/bin/env node
// "How one Friar position becomes N Uniswap positions" — the second social diagram.
//
//   node apps/site/scripts/make-shape-anatomy-png.mjs [outPath] [--scale=2]
//
// The thing people can't picture: a shaped position looks like one object in the app and is
// actually a fan of independent Uniswap v4 LP positions underneath, one per bin, all minted
// in a single transaction and tracked as a single record.
//
// Everything here is REAL, taken from live position #7 rather than drawn to look plausible:
// 85 bins, tickSpacing 160, ticks 144000→157600, the liquidity taper below, and the actual
// keccak salts. If you regenerate this for a different position, re-pull all of it — a
// diagram that invents its own numbers is worse than no diagram.
//
//   bins:   SELECT bin_index, tick_lower, liquidity FROM position_bins WHERE position_id=7
//   salt:   keccak256(abi.encodePacked(uint256 positionId, uint256 binIndex))
//
// Same resvg + IBM Plex + Friar's Robe pipeline as make-anatomy-png.mjs.
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
const OUT = out ?? join(here, "../../../../notes/launch-assets/friar-shape-anatomy.png");
const SCALE = arg("scale", 2);

const BG = "#100c07", PANEL = "#181209", PANEL_IN = "#211910";
const BORDER = "#2a2012", BORDER_HI = "#463620";
const TEXT = "#ece3d2", DIM = "#8a7a5f", FAINT = "#5d5138";
const ACCENT = "#cf9440", GREEN = "#8fbf5f";
const BIN_BID = "rgba(207,148,64,0.85)", BIN_ASK = "rgba(143,191,95,0.8)", BIN_ACTIVE = "#ece3d2";

const W = 1600, H = 900, M = 64;
const SANS = "IBM Plex Sans", MONO = "IBM Plex Mono";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const t = (x, y, s, { size = 20, fill = TEXT, font = SANS, weight = 400, anchor = "middle", ls = 0 } = {}) =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}"${ls ? ` letter-spacing="${ls}"` : ""}>${esc(s)}</text>`;
const box = (x, y, w, h, { stroke = BORDER_HI, fill = PANEL_IN, sw = 1.5, dash = "" } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;

// Live position #7, normalised so the tallest bin is 1. Linear taper peaking on the bin that
// was active at open (tick 148000): 25 bins of bids under it, 59 of asks over it.
const SHAPE = [0.04,0.08,0.12,0.15,0.19,0.23,0.27,0.31,0.35,0.38,0.42,0.46,0.50,0.54,0.58,0.61,0.65,0.69,0.73,0.77,0.81,0.85,0.88,0.92,0.96,1.00,0.98,0.98,0.97,0.95,0.93,0.92,0.90,0.88,0.86,0.85,0.83,0.81,0.80,0.78,0.76,0.75,0.73,0.71,0.69,0.68,0.66,0.64,0.63,0.61,0.59,0.58,0.56,0.54,0.53,0.51,0.49,0.47,0.46,0.44,0.42,0.41,0.39,0.37,0.36,0.34,0.32,0.30,0.29,0.27,0.25,0.24,0.22,0.20,0.19,0.17,0.15,0.14,0.12,0.10,0.08,0.07,0.05,0.03,0.02];
const ACTIVE_IDX = 25; // the peak, and the bin holding both tokens at open
const TICK0 = 144000, SPACING = 160;

// ---- histogram: the shape as the app draws it -------------------------------------------
const HX = 470, HY = 300, HW = 560, HH = 210;
const bw = HW / SHAPE.length;
const bars = SHAPE.map((v, i) => {
  const h = Math.max(3, v * HH);
  const fill = i < ACTIVE_IDX ? BIN_BID : i > ACTIVE_IDX ? BIN_ASK : BIN_ACTIVE;
  return `<rect x="${(HX + i * bw).toFixed(1)}" y="${(HY + HH - h).toFixed(1)}" width="${Math.max(1.5, bw - 1.2).toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}"/>`;
}).join("");

// ---- the fan: a few real bins as their own v4 positions ----------------------------------
const RX = 1090, RW = W - M - RX, RY = 286, RH = 42, RGAP = 9;
// Real salts for THESE bin indices, keccak256(uint256 7, uint256 binIndex). Anyone can
// recompute them, so they have to be right: an earlier draft had them shifted by one row and
// one of them invented outright, which would have been caught by the first person to check.
const rowsData = [
  ["bin 84", "144000 → 144160", "0x2884…c312"],
  ["bin 83", "144160 → 144320", "0x42b5…81c5"],
  ["bin 59", "148000 → 148160", "0x2540…72b0"],
  ["…", "…", "…"],
  ["bin 57", "157440 → 157600", "0x7fdb…7548"],
];
const rows = rowsData.map(([b, ticks, salt], i) => {
  const y = RY + i * (RH + RGAP);
  const isGap = b === "…";
  if (isGap) return t(RX + RW / 2, y + 26, "· · ·  81 more bins  · · ·", { size: 16, fill: FAINT, font: MONO });
  return `${box(RX, y, RW, RH, { fill: PANEL, stroke: BORDER })}
    ${t(RX + 14, y + 27, b, { size: 17, fill: ACCENT, font: MONO, anchor: "start" })}
    ${t(RX + 96, y + 27, ticks, { size: 16, fill: TEXT, font: MONO, anchor: "start" })}
    ${t(RX + RW - 14, y + 27, salt, { size: 15, fill: DIM, font: MONO, anchor: "end" })}`;
}).join("");

// One arrow between the columns instead of a fan of connectors: lines drawn across the
// histogram read as data rather than as plumbing.
const bridge = `<line x1="${HX + HW + 14}" y1="${HY + HH / 2}" x2="${RX - 14}" y2="${HY + HH / 2}" stroke="${ACCENT}" stroke-width="2"/>
  <polygon points="${RX - 6},${HY + HH / 2} ${RX - 17},${HY + HH / 2 - 6} ${RX - 17},${HY + HH / 2 + 6}" fill="${ACCENT}"/>
  ${t((HX + HW + RX) / 2, HY + HH / 2 - 14, "85 mints", { size: 16, fill: DIM, font: MONO })}
  ${t((HX + HW + RX) / 2, HY + HH / 2 + 26, "one tx", { size: 16, fill: GREEN, font: MONO })}`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${BG}"/>

  ${t(M, 78, "FRIAR", { size: 32, fill: ACCENT, font: MONO, weight: 600, anchor: "start", ls: 9 })}
  ${t(W - M, 76, "ANATOMY OF A SHAPED POSITION", { size: 17, fill: DIM, font: MONO, anchor: "end", ls: 3 })}
  <line x1="${M}" y1="108" x2="${W - M}" y2="108" stroke="${BORDER}" stroke-width="1"/>
  ${t(M, 172, "One position, one Uniswap position per bin", { size: 44, fill: TEXT, weight: 600, anchor: "start" })}
  ${t(M, 214, "You choose the range, the shape, and how many bins to spread across, up to 100. The manager", { size: 21, fill: DIM, anchor: "start" })}
  ${t(M, 242, "mints one v4 LP position per bin in a single transaction. The example below uses 85.", { size: 21, fill: DIM, anchor: "start" })}

  <!-- 1. what you do in the app -->
  ${box(M, 286, 340, 246)}
  ${t(M + 20, 320, "YOU CHOOSE", { size: 17, fill: DIM, font: MONO, anchor: "start", ls: 2 })}
  ${t(M + 20, 356, "shape", { size: 19, fill: DIM, anchor: "start" })}
  ${t(M + 320, 356, "Curve", { size: 19, fill: TEXT, font: MONO, anchor: "end" })}
  ${t(M + 20, 386, "range", { size: 19, fill: DIM, anchor: "start" })}
  ${t(M + 320, 386, "144000 → 157600", { size: 18, fill: TEXT, font: MONO, anchor: "end" })}
  ${t(M + 20, 416, "bins", { size: 19, fill: DIM, anchor: "start" })}
  ${t(M + 320, 416, "85 · up to 100", { size: 18, fill: ACCENT, font: MONO, anchor: "end" })}
  ${t(M + 20, 446, "bin width", { size: 19, fill: DIM, anchor: "start" })}
  ${t(M + 320, 446, "160 ticks · 1.6%", { size: 18, fill: TEXT, font: MONO, anchor: "end" })}
  ${t(M + 20, 476, "deposit", { size: 19, fill: DIM, anchor: "start" })}
  ${t(M + 320, 476, "0.18 WETH", { size: 18, fill: TEXT, font: MONO, anchor: "end" })}
  <line x1="${M + 20}" y1="494" x2="${M + 320}" y2="494" stroke="${BORDER}"/>
  ${t(M + 170, 518, "one signature", { size: 18, fill: GREEN, font: MONO })}

  <!-- arrow into the manager -->
  <line x1="${M + 348}" y1="398" x2="${HX - 16}" y2="398" stroke="${ACCENT}" stroke-width="2"/>
  <polygon points="${HX - 8},398 ${HX - 19},392 ${HX - 19},404" fill="${ACCENT}"/>

  <!-- 2. the manager: the shape it computes -->
  ${t(HX, 276, "FriarPositionManager", { size: 21, fill: ACCENT, font: MONO, anchor: "start" })}
  ${bars}
  <line x1="${HX}" y1="${HY + HH + 2}" x2="${HX + HW}" y2="${HY + HH + 2}" stroke="${BORDER_HI}"/>
  <line x1="${(HX + ACTIVE_IDX * bw + bw / 2).toFixed(1)}" y1="${HY - 12}" x2="${(HX + ACTIVE_IDX * bw + bw / 2).toFixed(1)}" y2="${HY + HH + 12}" stroke="${DIM}" stroke-width="1.2" stroke-dasharray="4 4"/>
  ${t(HX + ACTIVE_IDX * bw + bw / 2, HY + HH + 28, "↑ price at open", { size: 16, fill: DIM, font: MONO })}
  ${t(HX, HY + HH + 54, "← 25 bins of bids (WETH)", { size: 16, fill: ACCENT, font: MONO, anchor: "start" })}
  ${t(HX + HW, HY + HH + 54, "59 bins of asks (token) →", { size: 16, fill: GREEN, font: MONO, anchor: "end" })}
  ${t(HX, HY + HH + 84, "one record on-chain: owner · pool key · every bin", { size: 18, fill: TEXT, anchor: "start" })}
  ${t(HX, HY + HH + 110, "each bin's salt = keccak256(positionId, binIndex),", { size: 16, fill: DIM, font: MONO, anchor: "start" })}
  ${t(HX, HY + HH + 132, "which namespaces it to this position and owner", { size: 16, fill: DIM, font: MONO, anchor: "start" })}

  ${bridge}

  <!-- 3. what Uniswap sees -->
  ${t(RX, 276, "what Uniswap v4 sees", { size: 21, fill: GREEN, font: MONO, anchor: "start" })}
  ${rows}
  ${t(RX, RY + 5 * (RH + RGAP) + 26, "One per bin, so 85 here.", { size: 17, fill: DIM, anchor: "start" })}
  ${t(RX, RY + 5 * (RH + RGAP) + 50, "Owner is the manager; ticks + salt", { size: 17, fill: DIM, anchor: "start" })}
  ${t(RX, RY + 5 * (RH + RGAP) + 72, "identify each one.", { size: 17, fill: DIM, anchor: "start" })}
  ${t(RX, RY + 5 * (RH + RGAP) + 102, "fees accrue per bin, separately", { size: 17, fill: GREEN, anchor: "start" })}

  <!-- the reverse -->
  ${box(M, H - 172, W - M * 2, 66, { fill: PANEL, stroke: BORDER })}
  ${t(M + 24, H - 131, "close()", { size: 19, fill: ACCENT, font: MONO, anchor: "start" })}
  ${t(M + 116, H - 131, "burns every bin, collects all their fees, and pays out once. One call out, same as one call in.", { size: 19, fill: TEXT, anchor: "start" })}

  <line x1="${M}" y1="${H - 74}" x2="${W - M}" y2="${H - 74}" stroke="${BORDER}" stroke-width="1"/>
  ${t(M, H - 36, "friar.fi", { size: 22, fill: ACCENT, font: MONO, anchor: "start", ls: 2 })}
  ${t(W - M, H - 36, "Robinhood Chain · 4663", { size: 19, fill: FAINT, font: MONO, anchor: "end" })}
</svg>`;

// --format=svg writes the vector straight out, which is what the docs use: crisp at any
// zoom, a few KB, and no rasterizer in the loop. PNG stays the default for social, where
// SVG is not an accepted upload.
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
