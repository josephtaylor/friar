import { createConfig, http } from "wagmi";
import { robinhoodChain } from "@friar/chain";

// No hardcoded connectors: wagmi's EIP-6963 discovery (on by default) surfaces every
// installed wallet extension as its own connector, so the UI can offer a chooser
// instead of grabbing whoever squatted window.ethereum.
export const config = createConfig({
  chains: [robinhoodChain],
  transports: {
    [robinhoodChain.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
