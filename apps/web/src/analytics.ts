// Funnel telemetry. Deliberately tiny and self-hosted: no third-party script, no cookie
// banner, no ad-tech. It answers exactly one question the 2026-07-24 launch could not —
// did anyone actually arrive, and where did they stop?
//
// The funnel we care about:
//   page_view → wallet_connect → open_plan → open_success
// Anything else is noise. `discord_click` rides along to tell whether the community link
// is doing anything.
//
// Privacy stance: no ip is stored server-side, and the ids here are random values this
// browser invents for itself — enough to count people and sessions, never enough to
// identify one. Cleared with localStorage.

import { getAccount } from "wagmi/actions";
import { describeConnector, type ConnectorLike } from "./wallet.js";
import { config } from "./wagmi.js";

// Same convention as api.ts / errors.tsx — VITE_API_URL, localhost in dev. Getting this
// wrong would have pointed local dev's events at the production funnel table.
const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8788";

export type EventName = "page_view" | "wallet_connect" | "open_plan" | "open_success" | "discord_click" | "docs_click";

const VISITOR_KEY = "friar:visitor";

/** crypto.randomUUID is missing on older Safari and absent entirely in non-secure
 * contexts. This module is imported by the app shell, so an unguarded call here throws
 * during module evaluation and takes the WHOLE APP down with a blank page — telemetry
 * managing to be the single point of failure for the product. Never let that happen. */
function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Stable-ish per-browser id. localStorage can throw (private mode, blocked storage), and
 * telemetry must never be the reason the app fails to boot — fall back to per-session. */
function visitorId(): string {
  try {
    let v = localStorage.getItem(VISITOR_KEY);
    if (!v) {
      v = randomId();
      localStorage.setItem(VISITOR_KEY, v);
    }
    return v;
  } catch {
    return sessionId;
  }
}

// Per-tab, so "sessions" means what a human would expect and a reload doesn't inflate it.
const sessionId = randomId();

/** Campaign attribution: ?ref= or the standard utm_source, captured ONCE per tab at boot.
 * Read at boot because in-app navigation rewrites the query string away, and the whole
 * point is knowing which post sent someone. */
const source = (() => {
  try {
    const sp = new URLSearchParams(location.search);
    return sp.get("ref") ?? sp.get("utm_source") ?? null;
  } catch {
    return null;
  }
})();

// Same-path page_views collapse — React Router can fire a couple of navigations for one
// human action, and a double-counted funnel is worse than none.
let lastPath: string | null = null;

/** Fire and forget. Never throws, never blocks, never awaited. */
export function track(name: EventName, meta?: Record<string, unknown>): void {
  try {
    if (name === "page_view") {
      if (location.pathname === lastPath) return;
      lastPath = location.pathname;
    }
    const body = JSON.stringify({
      name,
      visitor: visitorId(),
      session: sessionId,
      path: location.pathname,
      referrer: document.referrer || undefined,
      source: source ?? undefined,
      address: getAccount(config).address ?? undefined,
      meta,
    });
    // keepalive so an event fired as the user navigates away still lands
    void fetch(`${BASE}/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* telemetry must never take the app down */
  }
}

/** Wallet connections, tracked once per address per tab (wagmi re-emits on reconnect and
 * chain change, which would otherwise read as a fresh conversion every time).
 *
 * `meta` carries the CONNECTOR (2026-09-03). Every wallet_connect row before that date has
 * meta NULL, so when an open failed with three signed approvals that never reached the
 * chain there was no way to tell which wallet had produced them — and "was that Phantom?"
 * is the first question anyone asks about a broken send on this chain. One field, and the
 * next visitor answers it. Wallet name only: this table holds no PII by design. */
const seenWallets = new Set<string>();
export function trackWalletConnect(address: string, connector?: ConnectorLike): void {
  const a = address.toLowerCase();
  if (seenWallets.has(a)) return;
  seenWallets.add(a);
  track("wallet_connect", describeConnector(connector));
}
