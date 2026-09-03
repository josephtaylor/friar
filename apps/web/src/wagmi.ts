import { createConfig, fallback, http } from "wagmi";
import { robinhoodChain } from "@friar/chain";

// No hardcoded connectors: wagmi's EIP-6963 discovery (on by default) surfaces every
// installed wallet extension as its own connector, so the UI can offer a chooser
// instead of grabbing whoever squatted window.ethereum.
export const config = createConfig({
  chains: [robinhoodChain],
  transports: {
    // fallback() over EVERY url in the chain def, not http() — bare http() reads only
    // rpcUrls.default.http[0], which is exactly how one throttled endpoint took the whole
    // app's reads down with it.
    [robinhoodChain.id]: fallback(robinhoodChain.rpcUrls.default.http.map((url) => http(url))),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
