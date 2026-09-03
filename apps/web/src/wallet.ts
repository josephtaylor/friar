// Wallet identification, in one place because two different screens need the same
// answer and got it differently before.
//
// Phantom is unusable on Robinhood Chain (2026-08-02): its security backend can't read
// chain 4663, so it renders the verified manager as "an EOA" behind a red full-screen
// warning, and its transaction simulation fails valid sends outright. Reported to
// Phantom; until it's fixed a Phantom user cannot complete an open no matter what we do.
//
// The original check lived in Gate.tsx and matched the connector NAME only, in the wallet
// chooser only. That left three ways in, all of which a real visitor can walk through:
//
//   1. it filtered a button, and never looked again after connect — a session persisted
//      from before the block (or any connect that doesn't route through the chooser)
//      sails past it;
//   2. a provider that doesn't announce itself as "Phantom" over EIP-6963 — Phantom
//      injecting as the generic window.ethereum when set as the browser default — fails
//      the name test while still being Phantom;
//   3. Phantom's own mobile in-app browser, which is how the ONE outside position this
//      app has ever had was opened (2026-08-02, ua `Phantom/ios/26.23.0.46452`) and which
//      the name test cannot see at all.
//
// So: match on every sync signal here, and on the provider's own `isPhantom` flag once
// there is a live connection. Delete this whole file when Phantom's chain support works.

/** Shape shared by wagmi's Connector and the chooser's view of one. */
export interface ConnectorLike {
  id: string;
  name: string;
  /** EIP-6963 reverse-dns id. Present on discovered connectors, absent on wagmi's own.
   * wagmi types this as string OR a list (one connector can front several rdns). */
  rdns?: string | readonly string[];
  getProvider?: () => Promise<unknown>;
}

/** Phantom's in-app browser stamps itself into the ua (`… Phantom/ios/26.23.0.46452`).
 * Cheap, sync, and the only signal available before a connector exists. */
export function isPhantomBrowser(): boolean {
  try {
    return /\bPhantom\//i.test(navigator.userAgent);
  } catch {
    return false;
  }
}

/** Everything we can tell WITHOUT awaiting a provider — safe to call during render. */
export function isPhantomConnector(c: ConnectorLike): boolean {
  const rdns = c.rdns === undefined ? [] : typeof c.rdns === "string" ? [c.rdns] : c.rdns;
  return (
    c.id === "app.phantom" ||
    rdns.some((r) => r === "app.phantom" || /phantom/i.test(r)) ||
    /phantom/i.test(c.name) ||
    /phantom/i.test(c.id)
  );
}

/** The authoritative check, once connected: Phantom's EVM provider sets `isPhantom` on
 * itself regardless of what name it announced. Never throws; a wallet that refuses to
 * hand over a provider is simply not identified as Phantom. */
export async function connectorIsPhantom(c: ConnectorLike | undefined): Promise<boolean> {
  if (!c) return false;
  if (isPhantomConnector(c)) return true;
  try {
    const p = (await c.getProvider?.()) as { isPhantom?: unknown } | undefined;
    return p?.isPhantom === true;
  } catch {
    return false;
  }
}

/** Connector identity for telemetry. `client_events.meta` was null on every wallet_connect
 * row ever written, so "which wallet was this person using?" — asked twice while
 * diagnosing the 2026-09-03 open that never reached the chain — had no answer in the data.
 * Names only, no address material: this rides in the funnel table, which stores no PII. */
export function describeConnector(c: ConnectorLike | undefined): Record<string, unknown> {
  if (!c) return { connector: "unknown" };
  return {
    connector: c.id,
    connectorName: c.name,
    ...(c.rdns === undefined ? {} : { rdns: typeof c.rdns === "string" ? c.rdns : [...c.rdns].join(",") }),
    ...(isPhantomBrowser() ? { phantomBrowser: true } : {}),
  };
}
