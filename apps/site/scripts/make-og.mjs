// Regenerates apps/site/og.png — the 1200x630 card that unfurls on X/Discord/Slack.
// The tagline is baked into the pixels, so it has to be rebuilt whenever the site copy
// changes (it was hand-made before, which is why the 2026-07-25 DLMM rename found a
// stale image still saying "Dynamic-fee liquidity"). Reuses the api's bundled IBM Plex
// TTFs and resvg-wasm — same rasterizer as the PnL share cards.
//
//   node apps/site/scripts/make-og.mjs ["Your tagline here"]
//
// Colors are lifted from apps/site/index.html's :root block — keep them in step.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, Resvg } from "@resvg/resvg-wasm";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "../../api/src/assets");
const out = join(here, "../public/og.png"); // only ./public is served

const TAGLINE = process.argv[2] ?? "A DLMM for Robinhood Chain";

const WORDMARK_LS = 52; // 0.3em-ish at 150px, matching the site's h1 letter-spacing
const BG = "#100c07";
const ACCENT = "#cf9440";
const TEXT = "#ece3d2";
const GOLD = "#cf9440";
const GREEN = "#8fbf5f";

// Bid-Ask shape: liquidity heavy at both edges, thin at the middle, with the active bin
// picked out pale — the same distribution the live site animates.
const BINS = 21;
const BAR_W = 20;
const GAP = 6;
const FIELD_W = BINS * BAR_W + (BINS - 1) * GAP;
const X0 = (1200 - FIELD_W) / 2;
const BASELINE = 530;
const MIN_H = 18;
const MAX_H = 118;

const bars = Array.from({ length: BINS }, (_, i) => {
  const t = Math.abs(i - (BINS - 1) / 2) / ((BINS - 1) / 2); // 0 center → 1 edge
  const h = MIN_H + (MAX_H - MIN_H) * Math.pow(t, 1.7);
  const x = X0 + i * (BAR_W + GAP);
  const active = i === (BINS - 1) / 2;
  const fill = active ? TEXT : i < (BINS - 1) / 2 ? GOLD : GREEN;
  return `<rect x="${x.toFixed(1)}" y="${(BASELINE - h).toFixed(1)}" width="${BAR_W}" height="${h.toFixed(1)}" fill="${fill}" rx="1.5" />`;
}).join("\n    ");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${BG}" />
  <!-- letter-spacing also applies AFTER the last glyph, so text-anchor="middle" lands the
       wordmark half a gap left of true centre — nudge x by LS/2, the same optical fix the
       site CSS does with text-indent: 0.3em. -->
  <text x="${600 + WORDMARK_LS / 2}" y="250" text-anchor="middle" font-family="IBM Plex Mono" font-weight="600"
        font-size="150" letter-spacing="${WORDMARK_LS}" fill="${ACCENT}">FRIAR</text>
  <text x="600" y="350" text-anchor="middle" font-family="IBM Plex Sans" font-weight="400"
        font-size="48" fill="${TEXT}">${TAGLINE.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>
  ${bars}
  <text x="600" y="580" text-anchor="middle" font-family="IBM Plex Mono" font-weight="400"
        font-size="26" letter-spacing="3" fill="${ACCENT}">friar.fi</text>
</svg>`;

await initWasm(readFileSync(fileURLToPath(import.meta.resolve("@resvg/resvg-wasm/index_bg.wasm"))));
const fonts = ["IBMPlexMono-Regular", "IBMPlexMono-SemiBold", "IBMPlexSans-Regular", "IBMPlexSans-SemiBold"].map(
  (f) => new Uint8Array(readFileSync(join(assets, `${f}.ttf`))),
);

const png = new Resvg(svg, {
  fitTo: { mode: "width", value: 1200 },
  font: { fontBuffers: fonts, defaultFontFamily: "IBM Plex Sans", loadSystemFonts: false },
}).render().asPng();

writeFileSync(out, png);
console.log(`wrote ${out} (${(png.length / 1024).toFixed(1)} KB) — tagline: "${TAGLINE}"`);
console.log('remember to bump the ?v= query on og:image / twitter:image so caches refetch');
