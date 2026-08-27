// Funnel telemetry intake. The web app POSTs one small event per call, fire-and-forget.
//
// Why this exists: the 2026-07-24 launch drew zero beta requests, and because the app
// logged errors but never page views, there was no way to tell "nobody came" from "came,
// read it, left before connecting a wallet". Those two need completely different fixes,
// so the distinction is the whole point.
//
// Unauthenticated by design — it fires before wallets connect. Defenses are an event-name
// allowlist, hard size caps, and a global per-minute ceiling. Deliberately stores NO ip:
// `visitor` is a random first-party id the browser generates, which is enough to count
// people without being able to identify one.

const MAX_TOTAL_PER_MIN = 600; // generous for real traffic, bounded against a flood

/** Allowlisted names. An open `name` column would let anyone write arbitrary labels into
 * the funnel and quietly poison every number we'd base a decision on. */
const NAMES = new Set([
  "page_view",
  "wallet_connect",
  "open_plan",
  "open_success",
  "discord_click",
  // docs_click was fired from six places in the app for weeks while missing from this
  // allowlist, so every one of them 400'd into the client's empty .catch() and recorded
  // nothing. Adding a name here is required for instrumenting one to do anything at all.
  "docs_click",
]);

export interface ClientEventBody {
  name?: string;
  visitor?: string;
  session?: string;
  path?: string;
  referrer?: string;
  source?: string;
  address?: string;
  meta?: unknown;
}

const cap = (s: unknown, n: number): string | null =>
  typeof s === "string" && s.length > 0 ? s.slice(0, n) : null;

/** Referrers are kept as bare ORIGIN, never the full URL — the path someone came from is
 * their business, and the origin is all that attributes a channel. */
function referrerOrigin(raw: unknown): string | null {
  const s = cap(raw, 500);
  if (!s) return null;
  try {
    return new URL(s).origin.slice(0, 120);
  } catch {
    return null;
  }
}

export async function handleClientEvent(
  db: D1Database,
  body: ClientEventBody,
  ua: string | undefined,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const name = cap(body.name, 40);
  if (!name || !NAMES.has(name)) return { status: 400, json: { error: "unknown event" } };

  const now = Math.floor(Date.now() / 1000);
  const recent = await db
    .prepare("SELECT COUNT(*) AS n FROM client_events WHERE ts > ?")
    .bind(now - 60)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_TOTAL_PER_MIN) return { status: 429, json: { error: "rate limited" } };

  const address =
    typeof body.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(body.address) ? body.address.toLowerCase() : null;
  // path only — a query string can carry an address or a token the user didn't mean to log
  const path = cap(typeof body.path === "string" ? body.path.split("?")[0] : null, 120);
  let meta: string | null = null;
  if (body.meta !== undefined && body.meta !== null) {
    try {
      meta = JSON.stringify(body.meta).slice(0, 400);
    } catch {
      meta = null;
    }
  }

  await db
    .prepare(
      `INSERT INTO client_events (ts, name, visitor, session, path, referrer, source, address, meta, ua)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      now,
      name,
      cap(body.visitor, 40),
      cap(body.session, 40),
      path,
      referrerOrigin(body.referrer),
      cap(body.source, 60),
      address,
      meta,
      cap(ua, 300),
    )
    .run();

  return { status: 200, json: { ok: true } };
}
