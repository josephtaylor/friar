// friar-indexer worker: hosts the ChainIndexer DO, the snapshot cron, and a tiny
// ops surface (/start /stop /status). Data lands in D1 for the API worker to read.
import { ChainIndexer } from "./indexer.js";
import { runSnapshots } from "./snapshots.js";
import { runTokenScan } from "./tokens.js";

export { ChainIndexer };

export interface Env {
  DB: D1Database;
  CHAIN_INDEXER: DurableObjectNamespace<ChainIndexer>;
  RPC_URL: string;
  /** Optional keyed endpoint, tried FIRST. A Worker secret, never a var — the URL
   * contains the API key. See src/rpc.ts. */
  RPC_URL_PRIMARY?: string;
  POOL_MANAGER: string;
  POSITION_MANAGER: string;
  START_BLOCK: string;
  /** bearer token for the control routes. Missing => they all refuse. A Worker secret:
   *  `npx wrangler secret put OPS_TOKEN` from apps/indexer. */
  OPS_TOKEN?: string;
}

/** Constant-time-ish bearer check. The control routes below mutate indexing state
 *  (/start can rewind the cursor to genesis and re-scan the whole chain), so they are
 *  gated. /status is read-only and /ingest-tx is called by the browser on an open
 *  receipt, so those two stay open. Fails CLOSED: no token configured, no access. */
function authorized(request: Request, token: string | undefined): boolean {
  if (!token) return false;
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (presented.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= presented.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const indexer = env.CHAIN_INDEXER.getByName("main");

    const GATED = new Set(["/start", "/stop", "/snapshot", "/scan-tokens", "/backfill"]);
    if (GATED.has(url.pathname) && !authorized(request, env.OPS_TOKEN)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    switch (url.pathname) {
      case "/start": {
        const fromParam = url.searchParams.get("from");
        const result = await indexer.start(fromParam !== null ? Number(fromParam) : undefined);
        return Response.json({ started: true, ...result });
      }
      case "/stop":
        await indexer.stop();
        return Response.json({ stopped: true });
      case "/status":
        return Response.json(await indexer.status());
      case "/snapshot": // manual trigger for testing
        await runSnapshots(env);
        return Response.json({ snapshotted: true });
      case "/scan-tokens": // manual trigger for testing the discovery cache
        return Response.json(await runTokenScan(env));
      case "/ingest-tx": {
        // eager ingest of a just-confirmed tx (the web calls this on open receipt)
        const hash = url.searchParams.get("hash");
        if (!hash?.startsWith("0x")) return Response.json({ error: "hash required" }, { status: 400 });
        const result = await indexer.ingestTx(hash as `0x${string}`);
        return Response.json(result, { headers: { "access-control-allow-origin": "*" } });
      }
      case "/backfill": {
        // one-shot historical candles for one pool: ?target=<v4 poolId | v3 address>&hours=48
        const target = url.searchParams.get("target");
        const hours = Number(url.searchParams.get("hours") ?? "48");
        if (!target?.startsWith("0x")) return Response.json({ error: "target required" }, { status: 400 });
        const result = await indexer.backfill(target as `0x${string}`, hours);
        return Response.json(result);
      }
      default:
        return new Response("friar-indexer", { status: 404 });
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runSnapshots(env));
    ctx.waitUntil(runTokenScan(env));
  },
} satisfies ExportedHandler<Env>;
