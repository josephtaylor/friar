// Regenerate packages/chain/src/abi/* from tuck forge artifacts.
// Run `forge build` in ../tuck first, then: node scripts/gen-abi.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tuckOut = join(root, "..", "tuck", "out");

const targets = [
  {
    artifact: join(tuckOut, "FriarPositionManager.sol", "FriarPositionManager.json"),
    exportName: "friarPositionManagerAbi",
    dest: join(root, "packages", "chain", "src", "abi", "friarPositionManager.ts"),
  },
];

for (const t of targets) {
  const { abi } = JSON.parse(readFileSync(t.artifact, "utf8"));
  const body =
    "// Generated from tuck forge artifact — do not edit by hand.\n" +
    "// Regenerate: node scripts/gen-abi.mjs (see package README)\n" +
    `export const ${t.exportName} = ` +
    JSON.stringify(abi, null, 2) +
    " as const;\n";
  writeFileSync(t.dest, body);
  console.log(`${t.exportName}: ${abi.length} entries -> ${t.dest}`);
}
