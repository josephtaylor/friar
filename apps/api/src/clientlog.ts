// Client error intake: the browser's `report()` posts here (fire-and-forget) so
// "it failed to do X" beta reports are diagnosable after the fact. Unauthenticated by
// design — errors happen before wallets connect — so the defenses are size caps and a
// D1-backed rate limit rather than identity. Rows are disposable telemetry, not state.

const MAX_PER_IP_PER_MIN = 30; // one stuck retry loop, not a flood
const MAX_TOTAL_PER_MIN = 300; // global backstop so a botnet can't grow the table fast

export interface ClientLogBody {
  address?: string;
  action?: string;
  positionId?: number;
  poolId?: string;
  txHash?: string;
  message?: string;
  url?: string;
}

const cap = (s: unknown, n: number): string | null =>
  typeof s === "string" && s.length > 0 ? s.slice(0, n) : null;

export async function handleClientLog(
  db: D1Database,
  clientIp: string | undefined,
  ua: string | undefined,
  body: ClientLogBody,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const message = cap(body.message, 4096);
  const action = cap(body.action, 120);
  if (!message || !action) return { status: 400, json: { error: "action and message required" } };

  const address =
    typeof body.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(body.address) ? body.address.toLowerCase() : null;
  const txHash = typeof body.txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(body.txHash) ? body.txHash.toLowerCase() : null;
  const poolId = typeof body.poolId === "string" && /^0x[0-9a-fA-F]{64}$/.test(body.poolId) ? body.poolId.toLowerCase() : null;
  const positionId = Number.isInteger(body.positionId) ? (body.positionId as number) : null;

  // Rate limit off the table itself — no KV/DO needed at beta volume. The ip rides in
  // the ua column ("ip | ua") so the limit needs no extra schema; drop it if it ever
  // matters for privacy.
  const now = Math.floor(Date.now() / 1000);
  const uaIp = cap(`${clientIp ?? "?"} | ${ua ?? "?"}`, 400);
  const minuteAgo = now - 60;
  const recent = await db
    .prepare("SELECT COUNT(*) AS total, SUM(ua LIKE ? || ' |%') AS mine FROM client_errors WHERE ts > ?")
    .bind(clientIp ?? "?", minuteAgo)
    .first<{ total: number; mine: number | null }>();
  if ((recent?.total ?? 0) >= MAX_TOTAL_PER_MIN || (recent?.mine ?? 0) >= MAX_PER_IP_PER_MIN)
    return { status: 429, json: { error: "rate limited" } };

  await db
    .prepare(
      `INSERT INTO client_errors (ts, address, action, position_id, pool_id, tx_hash, message, url, ua)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(now, address, action, positionId, poolId, txHash, message, cap(body.url, 300), uaIp)
    .run();

  // Mirror into Workers Logs so live tailing sees client errors next to server ones.
  console.error(`client-error [${action}] ${address ?? "no-wallet"}: ${message.slice(0, 300)}`);
  return { status: 200, json: { ok: true } };
}
