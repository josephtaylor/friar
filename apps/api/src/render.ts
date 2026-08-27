// PNG rasterization for the share card — the impure half of card.ts. Fonts, the monk
// mascot, and the resvg wasm are bundled into the worker (wrangler Data/CompiledWasm
// rules); everything initializes lazily on the first card request.
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import monoRegular from "./assets/IBMPlexMono-Regular.ttf";
import monoSemiBold from "./assets/IBMPlexMono-SemiBold.ttf";
import sansRegular from "./assets/IBMPlexSans-Regular.ttf";
import sansSemiBold from "./assets/IBMPlexSans-SemiBold.ttf";
import monkPng from "./assets/monk.png";
import { cardSvg, type CardData } from "./card.js";

let wasmReady: Promise<void> | null = null;
const ensureWasm = (): Promise<void> => (wasmReady ??= initWasm(resvgWasm as WebAssembly.Module));

let monkUri: string | null = null;
function monkDataUri(): string {
  if (monkUri) return monkUri;
  const bytes = new Uint8Array(monkPng);
  let bin = "";
  const CHUNK = 0x8000; // btoa argument limits — encode in chunks
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  monkUri = `data:image/png;base64,${btoa(bin)}`;
  return monkUri;
}

export async function renderCardPng(data: CardData): Promise<Uint8Array> {
  await ensureWasm();
  const svg = cardSvg(data, monkDataUri());
  const resvg = new Resvg(svg, {
    font: {
      fontBuffers: [
        new Uint8Array(monoRegular),
        new Uint8Array(monoSemiBold),
        new Uint8Array(sansRegular),
        new Uint8Array(sansSemiBold),
      ],
      loadSystemFonts: false,
      defaultFontFamily: "IBM Plex Mono",
    },
  });
  return resvg.render().asPng();
}
