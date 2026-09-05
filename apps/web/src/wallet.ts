// Wallet identification, in one place because two different screens need the same
// answer and got it differently before.
//
// Phantom does not support connecting to apps on Robinhood Chain. That is Phantom's own
// documented limit, not a bug we found: their Robinhood Chain FAQ says "dApp connectivity
// is not currently available", and their connect-to-apps page still lists chain 4663
// alongside Bitcoin as a network you cannot connect to apps on (checked 2026-09-05).
// Phantom DID add Robinhood Chain on 2026-07-23, which is what people have heard, but what
// shipped is wallet-side balances / send / receive / swap / bridge. Signing a contract call
// from a website is not in it, which is the cleanest explanation for the 2026-09-03 open
// whose three signed approvals never reached the sequencer.
//
// EXCEPT the mobile in-app browser, which is allowed through (2026-09-05). Phantom's own
// browser injects a provider that works in practice: the only outside position this app has
// ever had was opened AND closed through it on 2026-08-02, both transactions on chain. It
// is the one Phantom path with evidence behind it, and a Solana-native user arriving on
// their phone is exactly who shows up here, so blocking it costs more than it protects.
// The desktop extension stays blocked; both paths get warned.
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
// there is a live connection. Delete this whole file when Phantom ships dapp connectivity
// for 4663.

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

/** Whether to refuse this connector in the wallet chooser. Phantom's extension cannot sign
 * for a website on this chain, so offering it is offering a dead end. Inside Phantom's own
 * mobile browser the same predicate matches but the path demonstrably works, so it is let
 * through and warned instead of blocked. */
export function isPhantomBlocked(c: ConnectorLike): boolean {
  return isPhantomConnector(c) && !isPhantomBrowser();
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
