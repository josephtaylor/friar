// Binary module imports, bundled by wrangler: .ttf/.png via the Data rule in
// wrangler.jsonc (→ ArrayBuffer), .wasm via the built-in CompiledWasm rule.
declare module "*.ttf" {
  const data: ArrayBuffer;
  export default data;
}
declare module "*.png" {
  const data: ArrayBuffer;
  export default data;
}
declare module "*.wasm" {
  const mod: WebAssembly.Module;
  export default mod;
}
