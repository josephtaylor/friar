import { defineConfig } from "tsup";

// One published package. The internal @friar/core and @friar/chain workspaces are
// bundled in, so consumers install a single dependency; viem stays external.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["viem"],
  noExternal: ["@friar/core", "@friar/chain"],
});
