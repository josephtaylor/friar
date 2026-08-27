#!/usr/bin/env node
// Renders the site hero's shape animation to a looping GIF — the bins morphing
// Bid-Ask → Spot → Curve, gold bids / green asks / parchment active bin.
//
//   node apps/site/scripts/make-shapes-gif.mjs [outPath] [--scale=2] [--fps=20] [--aspect=1.333]
//
// This SIMULATES the animation rather than screen-recording it, deliberately: the numbers
// below are copied from the inline script in apps/site/index.html, so the output is
// deterministic, seamlessly loopable (it renders exactly one whole 3-shape cycle), and
// free of capture jitter. If you retune the animation on the site, retune it here too —
// the constants are duplicated on purpose, and that's the cost of the fidelity.
//
// Rasterizes each frame with the same resvg + IBM Plex stack as the OG card, then lets
// ffmpeg build an optimised palette (a flat-colour animation like this needs a real
// palette pass, not the default 256-colour dither).

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { initWasm, Resvg } from "@resvg/resvg-wasm";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "../../api/src/assets");
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? Number(hit.split("=")[1]) : d;
};
const out = process.argv[2]?.startsWith("--") ? undefined : process.argv[2];
const OUT = out ?? join(here, "../../../../notes/launch-assets/friar-shapes.gif");
const SCALE = arg("scale", 2);
const FPS = arg("fps", 20);
// width:height. The bin field is a wide, thin band, so a 1:1 canvas is mostly air —
// 4:3 reads as composed, --aspect=1 gives a true square for feeds that prefer it.
const ASPECT = arg("aspect", 4 / 3);

// ---- constants lifted verbatim from the site's inline animation ----------------------
const W = 560;
const H = 96;
const N = 25;
const GAP = 3;
const BW = (W - (N - 1) * GAP) / N;
const C = (N - 1) / 2;
const SHAPES = ["bidask", "spot", "curve"];
const LABELS = { bidask: "Bid-Ask", spot: "Spot", curve: "Curve" };
const HOLD_FRAMES = 156; // ~2.6s at 60fps
const EASE = 0.09;
const SIM_FPS = 60;

function target(shape, i) {
  if (shape === "spot") return 0.6;
  if (shape === "curve") return 0.12 + 0.88 * Math.exp(-Math.pow((i - C) / (N * 0.24), 2));
  return 0.16 + 0.84 * Math.pow(Math.abs(i - C) / C, 1.4); // bid-ask
}

const BG = "#100c07";
const GOLD = "rgba(207,148,64,0.85)";
const GREEN = "rgba(143,191,95,0.8)";
const ACTIVE = "#ece3d2";
const ACCENT = "#cf9440";
const FAINT = "#5d5138";
const fillFor = (i) => (i < Math.floor(C) ? GOLD : i > Math.ceil(C) ? GREEN : ACTIVE);

// Layout: the bin field plus the shape-name row underneath, same order as the site.
// The content is a fixed-height band; the canvas is sized from the aspect ratio and the
// band is centred vertically in it, so changing --aspect only changes the air around it.
const PAD = 20;
const LABEL_Y = H + 34;
const CONTENT_H = LABEL_Y + 14; // bins + label baseline + descender room
const CANVAS_W = W + PAD * 2;
const CANVAS_H = Math.round(CANVAS_W / ASPECT);
const TOP = Math.max(PAD, Math.round((CANVAS_H - CONTENT_H) / 2));

function svgFrame(heights, shape) {
  const bars = heights
    .map((v, i) => {
      const h = Math.max(2.5, v * (H - 6));
      const x = PAD + i * (BW + GAP);
      return `<rect x="${x.toFixed(1)}" y="${(TOP + H - h).toFixed(1)}" width="${BW.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${fillFor(i)}"/>`;
    })
    .join("");
  // three names, centred as a row, active one in rope-gold
  const gapPx = 24;
  const widths = SHAPES.map((s) => LABELS[s].length * 7.4);
  const total = widths.reduce((a, b) => a + b, 0) + gapPx * 2;
  let x = PAD + (W - total) / 2;
  const names = SHAPES.map((s, k) => {
    const cx = x + widths[k] / 2;
    x += widths[k] + gapPx;
    return `<text x="${cx.toFixed(1)}" y="${TOP + LABEL_Y}" text-anchor="middle" font-family="IBM Plex Mono" font-size="12" letter-spacing="0.5" fill="${s === shape ? ACCENT : FAINT}">${LABELS[s]}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}">
  <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="${BG}"/>
  ${bars}
  ${names}
</svg>`;
}

await initWasm(readFileSync(fileURLToPath(import.meta.resolve("@resvg/resvg-wasm/index_bg.wasm"))));
const fonts = ["IBMPlexMono-Regular", "IBMPlexMono-SemiBold", "IBMPlexSans-Regular", "IBMPlexSans-SemiBold"].map(
  (f) => new Uint8Array(readFileSync(join(assets, `${f}.ttf`))),
);

// Simulate at 60fps for identical easing to the browser, emit every `step`-th frame.
const step = Math.max(1, Math.round(SIM_FPS / FPS));
const totalSim = HOLD_FRAMES * SHAPES.length;

// Start where the loop will END so the GIF cycles seamlessly: run the sim once to reach
// steady state on the last shape before recording.
let heights = Array.from({ length: N }, (_, i) => target("bidask", i));
let si = 0;
let frames = 0;
const advance = () => {
  if (++frames % HOLD_FRAMES === 0) si = (si + 1) % SHAPES.length;
  const shape = SHAPES[si];
  for (let i = 0; i < N; i++) heights[i] += (target(shape, i) - heights[i]) * EASE;
  return shape;
};
for (let f = 0; f < totalSim; f++) advance(); // one warm-up cycle → seamless loop point

const dir = mkdtempSync(join(tmpdir(), "friar-shapes-"));
let emitted = 0;
try {
  for (let f = 0; f < totalSim; f++) {
    const shape = advance();
    if (f % step !== 0) continue;
    const png = new Resvg(svgFrame(heights, shape), {
      fitTo: { mode: "width", value: CANVAS_W * SCALE },
      font: { fontBuffers: fonts, defaultFontFamily: "IBM Plex Sans", loadSystemFonts: false },
    })
      .render()
      .asPng();
    writeFileSync(join(dir, `f${String(emitted).padStart(4, "0")}.png`), png);
    emitted++;
  }
  console.error(
    `rendered ${emitted} frames at ${CANVAS_W * SCALE}x${CANVAS_H * SCALE} (${FPS}fps → ${(emitted / FPS).toFixed(1)}s loop)`,
  );

  // Two-pass palette: one shared palette across all frames, so flat fills stay flat and
  // the active bin doesn't shimmer between frames.
  const palette = join(dir, "palette.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(dir, "f%04d.png"), "-vf", "palettegen=stats_mode=full", palette]);
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-framerate", String(FPS),
    "-i", join(dir, "f%04d.png"),
    "-i", palette,
    "-lavfi", "paletteuse=dither=none:diff_mode=rectangle",
    "-loop", "0",
    OUT,
  ]);
  // drop frames that are byte-identical to their predecessor
  execFileSync("magick", [OUT, "-layers", "optimize", OUT]);
  const kb = (readFileSync(OUT).length / 1024).toFixed(0);
  console.log(`wrote ${OUT} (${kb} KB)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
