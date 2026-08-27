// Render sample share cards to PNGs for eyeballing against the design mocks
// (design handoff frames 6a/6b/6c). Usage:
//   node apps/api/scripts/card-preview.mjs [outDir]
// Requires node >= 23.6 (imports ../src/card.ts via native type stripping).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { buildCardData, cardSvg } from "../src/card.ts";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "../src/assets");
const outDir = process.argv[2] ?? join(here, "../card-preview");
mkdirSync(outDir, { recursive: true });

await initWasm(readFileSync(fileURLToPath(import.meta.resolve("@resvg/resvg-wasm/index_bg.wasm"))));
const fonts = ["IBMPlexMono-Regular", "IBMPlexMono-SemiBold", "IBMPlexSans-Regular", "IBMPlexSans-SemiBold"].map(
  (f) => new Uint8Array(readFileSync(join(assets, `${f}.ttf`))),
);
const monk = `data:image/png;base64,${readFileSync(join(assets, "monk.png")).toString("base64")}`;

const E = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n; // ether-ish helper
const jul = (day, plusSec = 0) => Math.floor(Date.UTC(2026, 6, day) / 1000) + plusSec;

const base = {
  quoteSym: "WETH",
  quoteDecimals: 18,
  usdPerQuote: 3611,
  metric: "percent",
  denom: "WETH",
  showAmounts: true,
  feeNowPips: null,
  feeSurge: false,
};

// the three master frames, with the handoff's sample numbers
const win = {
  ...base,
  symbol: "PEANUT",
  open: false,
  openedTs: jul(8),
  closedTs: jul(13, 2 * 3600 + 24 * 60),
  now: jul(15),
  pnlQuote: E(0.0311),
  feesNetQuote: E(0.0402),
  basisQuote: E(0.3305),
  feeAvgPips: 6200,
};
const loss = {
  ...base,
  symbol: "DEGEN",
  open: false,
  openedTs: jul(6),
  closedTs: jul(7, 4 * 3600 + 48 * 60),
  now: jul(15),
  pnlQuote: -E(0.024),
  feesNetQuote: E(0.0038),
  basisQuote: E(0.3333),
  feeAvgPips: 9400,
};
const open = {
  ...base,
  symbol: "CASHCAT",
  open: true,
  openedTs: jul(15),
  closedTs: null,
  now: jul(17, 7 * 3600 + 12 * 60),
  pnlQuote: E(0.0023),
  feesNetQuote: E(0.012),
  basisQuote: E(0.2439),
  feeAvgPips: 7100,
  feeNowPips: 8700,
  feeSurge: true,
};

const states = {
  "6a-win": win,
  "6b-loss": loss,
  "6c-open": open,
  "x-win-amount": { ...win, metric: "amount" },
  "x-win-usd": { ...win, metric: "amount", denom: "USD" },
  "x-win-private": { ...win, showAmounts: false },
};

for (const [name, inp] of Object.entries(states)) {
  const svg = cardSvg(buildCardData(inp), monk);
  const png = new Resvg(svg, {
    font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: "IBM Plex Mono" },
  })
    .render()
    .asPng();
  writeFileSync(join(outDir, `${name}.png`), png);
  console.log(`${name}.png  ${(png.length / 1024).toFixed(0)}KB`);
}
console.log(`→ ${outDir}`);
