import React from "react";
import ReactDOM from "react-dom/client";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { config } from "./wagmi.js";
import { App } from "./App.js";
import { DenomProvider } from "./denom.js";
import { ErrorBoundary, installGlobalErrorReporting } from "./errors.js";
import { installViemWalkFix } from "./viemWalk.js";
import "./app.css";

// Before anything can trigger a contract write: viem's BaseError.walk crashes on a
// primitive in the cause chain, which destroys the real error from wallets that reject
// with a bare string. See viemWalk.ts.
installViemWalkFix();
installGlobalErrorReporting();

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <DenomProvider>
          <BrowserRouter>
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </BrowserRouter>
        </DenomProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);
