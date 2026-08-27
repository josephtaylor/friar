#!/usr/bin/env node
// Renders the "where your money sits" diagram as a standalone PNG for social posts.
//
//   node apps/site/scripts/make-anatomy-png.mjs [outPath] [--scale=2]
//
// Why a script and not an export from the web page: the artifact renders with whatever sans
// the viewer happens to have, and the whole point of this image is that it looks like the
// app. Rendering here uses the same resvg + real IBM Plex TTFs as the OG card and the shapes
// GIF, and the same Friar's Robe tokens as apps/web/src/app.css, so it sits next to the
// product instead of looking like a generic diagram.
//
// 1600x900 at scale 2 → 3200x1800. That's 16:9, which is what X shows uncropped in a
// timeline, and big enough that the box labels survive their compression.
//
// Text is sized for the TIMELINE, not for full screen. Anything that needs the reader to
// open the image is in the page version instead: claude.ai artifact today, friar.fi later.
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
const OUT = out ?? join(here, "../../../../notes/launch-assets/friar-anatomy.png");
const SCALE = arg("scale", 2);

// Friar's Robe, from apps/web/src/app.css
const BG = "#100c07";
const PANEL = "#181209";
const PANEL_IN = "#211910";
const BORDER = "#2a2012";
const BORDER_HI = "#463620";
const TEXT = "#ece3d2";
const DIM = "#8a7a5f";
const FAINT = "#5d5138";
const ACCENT = "#cf9440";
const GREEN = "#8fbf5f";

const W = 1600;
const H = 900;
const M = 64; // page margin

const SANS = "IBM Plex Sans";
const MONO = "IBM Plex Mono";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const t = (x, y, s, { size = 20, fill = TEXT, font = SANS, weight = 400, anchor = "middle", ls = 0 } = {}) =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}"${ls ? ` letter-spacing="${ls}"` : ""}>${esc(s)}</text>`;
const box = (x, y, w, h, { stroke = BORDER_HI, fill = PANEL_IN, sw = 1.5 } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;

// ---- geometry: three columns across the usable width, gaps left for the arrows ----------
const COLS = [290, 400, 470];
const GAP = (W - M * 2 - COLS.reduce((a, b) => a + b, 0)) / 2;
const X = [M, M + COLS[0] + GAP, M + COLS[0] + GAP + COLS[1] + GAP];
const CX = X.map((x, i) => x + COLS[i] / 2);
const ROW_Y = 336;
const ROW_H = 244;
const ROW_B = ROW_Y + ROW_H;

const arrow = (x1, y, x2, color, label) => {
  const dir = x2 > x1 ? 1 : -1;
  const head = `${x2},${y} ${x2 - 11 * dir},${y - 6} ${x2 - 11 * dir},${y + 6}`;
  return `<line x1="${x1}" y1="${y}" x2="${x2 - 9 * dir}" y2="${y}" stroke="${color}" stroke-width="2"/>
    <polygon points="${head}" fill="${color}"/>
    ${t((x1 + x2) / 2, y - 14, label, { size: 18, fill: color === GREEN ? GREEN : DIM, font: MONO })}`;
};

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${BG}"/>

  <!-- masthead -->
  ${t(M, 78, "FRIAR", { size: 32, fill: ACCENT, font: MONO, weight: 600, anchor: "start", ls: 9 })}
  ${t(W - M, 76, "ANATOMY OF A POSITION", { size: 17, fill: DIM, font: MONO, anchor: "end", ls: 3 })}
  <line x1="${M}" y1="108" x2="${W - M}" y2="108" stroke="${BORDER}" stroke-width="1"/>
  ${t(M, 176, "Where your money actually sits", { size: 46, fill: TEXT, weight: 600, anchor: "start" })}
  ${t(M, 218, "The manager mints your bins inside Uniswap's PoolManager and keeps a record of them.", { size: 21, fill: DIM, anchor: "start" })}
  ${t(M, 248, "It never holds a balance of its own.", { size: 21, fill: DIM, anchor: "start" })}

  <!-- the hook, above the pool it prices -->
  ${box(X[2], 168, COLS[2], 108, { fill: PANEL })}
  ${t(CX[2], 205, "Friar hook", { size: 23, fill: TEXT, font: MONO })}
  ${t(CX[2], 234, "sets dynamic swap fee", { size: 19, fill: DIM })}
  ${t(CX[2], 259, "not called on deposits or withdrawals", { size: 18, fill: GREEN })}
  <line x1="${CX[2]}" y1="276" x2="${CX[2]}" y2="${ROW_Y - 12}" stroke="${DIM}" stroke-width="2" stroke-dasharray="6 6"/>
  <polygon points="${CX[2]},${ROW_Y - 4} ${CX[2] - 6},${ROW_Y - 15} ${CX[2] + 6},${ROW_Y - 15}" fill="${DIM}"/>
  ${t(CX[2] + 112, ROW_Y - 24, "fee only", { size: 18, fill: DIM, font: MONO })}

  <!-- your wallet -->
  ${box(X[0], ROW_Y, COLS[0], ROW_H)}
  ${t(CX[0], ROW_Y + 56, "YOUR WALLET", { size: 24, fill: TEXT, font: MONO, ls: 1 })}
  ${t(CX[0], ROW_Y + 108, "signs every action", { size: 20, fill: DIM })}
  ${t(CX[0], ROW_Y + 140, "holds your tokens", { size: 20, fill: DIM })}
  ${t(CX[0], ROW_Y + 194, "every payout lands here", { size: 20, fill: GREEN })}

  <!-- the manager -->
  ${box(X[1], ROW_Y, COLS[1], ROW_H, { stroke: ACCENT })}
  ${t(CX[1], ROW_Y + 52, "FriarPositionManager", { size: 23, fill: ACCENT, font: MONO })}
  ${t(CX[1], ROW_Y + 96, "stores your position", { size: 20, fill: DIM })}
  ${t(CX[1], ROW_Y + 126, "owner · pool key · bins", { size: 19, fill: TEXT, font: MONO })}
  <line x1="${X[1] + 40}" y1="${ROW_Y + 152}" x2="${X[1] + COLS[1] - 40}" y2="${ROW_Y + 152}" stroke="${BORDER}"/>
  ${t(CX[1], ROW_Y + 184, "routes your calls into v4", { size: 20, fill: DIM })}
  ${t(CX[1], ROW_Y + 216, "never holds a balance", { size: 20, fill: GREEN })}

  <!-- uniswap, where the money is -->
  ${box(X[2], ROW_Y, COLS[2], ROW_H, { stroke: GREEN, sw: 2, fill: PANEL })}
  ${t(CX[2], ROW_Y + 52, "Uniswap v4 PoolManager", { size: 23, fill: GREEN, font: MONO })}
  ${t(CX[2], ROW_Y + 100, "YOUR LIQUIDITY LIVES HERE", { size: 23, fill: TEXT, weight: 600 })}
  ${t(CX[2], ROW_Y + 136, "Uniswap's own contract", { size: 20, fill: DIM })}
  ${t(CX[2], ROW_Y + 176, "positions keyed by owner", { size: 19, fill: DIM })}
  ${t(CX[2], ROW_Y + 206, "fees accrue in place", { size: 19, fill: DIM })}

  <!-- flows -->
  ${arrow(X[0] + COLS[0] + 8, ROW_Y + 82, X[1] - 8, ACCENT, "calls")}
  ${arrow(X[1] - 8, ROW_Y + 168, X[0] + COLS[0] + 8, GREEN, "payouts")}
  ${arrow(X[1] + COLS[1] + 8, ROW_Y + 82, X[2] - 8, ACCENT, "liquidity")}
  ${arrow(X[2] - 8, ROW_Y + 168, X[1] + COLS[1] + 8, GREEN, "fees")}

  <!-- treasury -->
  ${box(X[1], ROW_B + 76, COLS[1], 104, { fill: PANEL })}
  ${t(CX[1], ROW_B + 112, "treasury", { size: 22, fill: TEXT, font: MONO })}
  ${t(CX[1], ROW_B + 143, "receives the performance fee", { size: 19, fill: DIM })}
  ${t(CX[1], ROW_B + 167, "can only waive it", { size: 19, fill: DIM })}
  <!-- the perf fee leaves the manager and goes DOWN to the treasury; arrowhead follows the money -->
  <line x1="${CX[1]}" y1="${ROW_B + 12}" x2="${CX[1]}" y2="${ROW_B + 66}" stroke="${DIM}" stroke-width="2" stroke-dasharray="6 6"/>
  <polygon points="${CX[1]},${ROW_B + 74} ${CX[1] - 6},${ROW_B + 63} ${CX[1] + 6},${ROW_B + 63}" fill="${DIM}"/>
  ${t(CX[1] + 132, ROW_B + 48, "perf fee", { size: 18, fill: DIM, font: MONO })}

  <!-- footer -->
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
  })
    .render()
    .asPng();
  writeFileSync(OUT, png);
  console.log(`wrote ${OUT} — ${W * SCALE}x${H * SCALE}, ${(png.length / 1024).toFixed(0)} KB`);
}
