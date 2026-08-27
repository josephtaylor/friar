// One RPC transport for the whole indexer, built from a comma-separated RPC_URL.
//
// Why: on 2026-07-25 the public sequencer endpoint started answering "Too Many Requests"
// to this Worker for hours at a stretch — while the identical calls from a laptop returned
// in ~130ms. That points at Cloudflare's shared egress being rate-limited rather than at
// our request pattern, which means no amount of batching fixes it (we already cut the
// marking pass from 366 loose calls to ~6 Multicall3 aggregates and it still got refused).
// The fix is more than one way out, so RPC_URL now takes a LIST and viem's `fallback`
// transport ranks and retries across it.
//
//   RPC_URL="https://robinhood-mainnet.g.alchemy.com/v2/KEY,https://rpc.mainnet.chain.robinhood.com,https://robinhood-rpc.publicnode.com"
//
// Order matters: put the endpoint with the fewest restrictions first. Known limits as of
// 2026-07-25, all measured rather than taken from a docs page:
//   · rpc.mainnet.chain.robinhood.com — no key, no range cap, but rate-limits our egress
//   · robinhood-rpc.publicnode.com    — no key, every eth_call fine, but eth_getLogs is
//     capped around 50 blocks ("archive requests require a personal token"), so it can
//     serve MARKING all day and cannot serve backfills at all
//   · Alchemy / QuickNode / dRPC       — keyed, no meaningful caps
//
// Consequence worth remembering: a fallback list can silently degrade rather than fail.
// If the only reachable endpoint is range-capped, wide getLogs pages keep throwing and the
// cursor stops advancing while marking looks perfectly healthy — exactly the split-brain
// that made the 07-25 outage confusing. The alarm logs both paths separately for that
// reason; check candle freshness and snapshot freshness independently.
import { createPublicClient, fallback, http, type PublicClient } from "viem";

/** Split a comma-separated endpoint list, tolerating whitespace and a trailing comma. */
export function rpcUrls(raw: string): string[] {
  return raw
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
}

/**
 * A keyed endpoint's URL contains its API key, so it must NEVER live in wrangler.jsonc
 * `vars` (those are committed). It goes in `RPC_URL_PRIMARY` as a Worker SECRET:
 *
 *   cd apps/indexer && npx wrangler secret put RPC_URL_PRIMARY
 *
 * When set it is tried first and the keyless list in RPC_URL becomes pure insurance.
 * When absent — local dev, or before a key exists — everything still works off RPC_URL,
 * so there is no secret to provision just to run the stack.
 */
export function rpcClient(env: { RPC_URL: string; RPC_URL_PRIMARY?: string }): PublicClient {
  const urls = [...rpcUrls(env.RPC_URL_PRIMARY ?? ""), ...rpcUrls(env.RPC_URL)];
  if (!urls.length) throw new Error("no RPC endpoints configured (RPC_URL / RPC_URL_PRIMARY)");
  return createPublicClient({
    transport:
      urls.length === 1
        ? http(urls[0]!)
        : // rank:false keeps our explicit order (viem's latency ranking would happily
          // promote a range-capped endpoint just because it answers small calls fast)
          fallback(
            urls.map((u) => http(u)),
            { rank: false, retryCount: 1 },
          ),
  });
}

/** Hostnames only, in order — safe to log, never includes the key path. */
export function rpcHosts(env: { RPC_URL: string; RPC_URL_PRIMARY?: string }): string[] {
  return [...rpcUrls(env.RPC_URL_PRIMARY ?? ""), ...rpcUrls(env.RPC_URL)].map((u) => {
    try {
      return new URL(u).host;
    } catch {
      return "MALFORMED-URL";
    }
  });
}

/** Probe each endpoint individually with eth_chainId and report host → verdict. viem's
 * `fallback` only surfaces the LAST endpoint's error, so when everything is failing there
 * is no way to tell a bad key from a rate limit from a typo'd URL. Called from the alarm's
 * failure path, where the answer is worth one extra round trip per endpoint. */
export async function probeEndpoints(env: { RPC_URL: string; RPC_URL_PRIMARY?: string }): Promise<string> {
  const urls = [...rpcUrls(env.RPC_URL_PRIMARY ?? ""), ...rpcUrls(env.RPC_URL)];
  const out = await Promise.all(
    urls.map(async (u) => {
      let host = "MALFORMED-URL";
      try {
        host = new URL(u).host;
      } catch {
        return `${host} (${u.slice(0, 12)}…)`;
      }
      try {
        const res = await fetch(u, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        });
        const text = (await res.text()).slice(0, 120);
        return `${host} → HTTP ${res.status} ${text}`;
      } catch (err) {
        return `${host} → threw ${String(err).slice(0, 80)}`;
      }
    }),
  );
  return out.join(" | ");
}

/** Retry a transient RPC failure a few times, briefly. Distinct from the fallback list:
 * fallback covers "this endpoint is wrong for this call", retry covers "this endpoint is
 * momentarily unhappy". Both are needed — on 2026-07-25 an Alchemy plan upgrade propagated
 * across their nodes over several minutes, so ~50% of identical requests were refused with
 * a stale free-tier error. Without a retry each refusal cost a whole poll cycle (5 min at
 * the backoff cap) and a 200k-block backfill would have crawled. */
export async function withRpcRetry<R>(fn: () => Promise<R>, attempts = 3): Promise<R> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
}
