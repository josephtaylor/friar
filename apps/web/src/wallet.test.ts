import { describe, it, expect, afterEach, vi } from "vitest";
import { isPhantomConnector, isPhantomBrowser, connectorIsPhantom, describeConnector } from "./wallet.js";

const ua = (s: string) => vi.stubGlobal("navigator", { userAgent: s });
afterEach(() => vi.unstubAllGlobals());

describe("isPhantomConnector", () => {
  it("catches the rdns id, which is the one signal Phantom always sends", () => {
    expect(isPhantomConnector({ id: "injected", name: "Browser Wallet", rdns: "app.phantom" })).toBe(true);
  });

  it("catches a connector list that fronts several rdns", () => {
    expect(isPhantomConnector({ id: "injected", name: "Injected", rdns: ["io.metamask", "app.phantom"] })).toBe(true);
  });

  it("still catches the plain name match the original check relied on", () => {
    expect(isPhantomConnector({ id: "app.phantom", name: "Phantom" })).toBe(true);
    expect(isPhantomConnector({ id: "injected", name: "Phantom (EVM)" })).toBe(true);
  });

  it("does not flag the wallets we tell people to use instead", () => {
    for (const c of [
      { id: "io.metamask", name: "MetaMask", rdns: "io.metamask" },
      { id: "io.rabby", name: "Rabby", rdns: "io.rabby" },
      { id: "com.trustwallet.app", name: "Trust Wallet" },
    ])
      expect(isPhantomConnector(c)).toBe(false);
  });
});

describe("isPhantomBrowser", () => {
  // The real ua from the only outside position this app has ever had (2026-08-02).
  it("recognises Phantom's mobile in-app browser", () => {
    ua("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Phantom/ios/26.23.0.46452");
    expect(isPhantomBrowser()).toBe(true);
  });

  it("leaves the same phone in plain Safari alone", () => {
    ua("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148");
    expect(isPhantomBrowser()).toBe(false);
  });
});

describe("connectorIsPhantom", () => {
  it("believes the provider over the announced name", async () => {
    const c = { id: "injected", name: "Browser Wallet", getProvider: async () => ({ isPhantom: true }) };
    await expect(connectorIsPhantom(c)).resolves.toBe(true);
  });

  it("is false, never a throw, when the provider refuses", async () => {
    const c = {
      id: "injected",
      name: "Browser Wallet",
      getProvider: async () => {
        throw new Error("locked");
      },
    };
    await expect(connectorIsPhantom(c)).resolves.toBe(false);
    await expect(connectorIsPhantom(undefined)).resolves.toBe(false);
  });
});

describe("describeConnector", () => {
  it("records the wallet identity that every pre-2026-09-03 connect row is missing", () => {
    ua("Chrome");
    expect(describeConnector({ id: "io.metamask", name: "MetaMask", rdns: "io.metamask" })).toEqual({
      connector: "io.metamask",
      connectorName: "MetaMask",
      rdns: "io.metamask",
    });
  });

  it("never carries an address, only names", () => {
    ua("Chrome");
    const meta = describeConnector({ id: "io.rabby", name: "Rabby" });
    expect(JSON.stringify(meta)).not.toMatch(/0x/);
  });
});
