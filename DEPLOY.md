# Deploying Friar

One command per target — `scripts/deploy.mjs` encodes the whole ritual so you never
have to rediscover it.

```bash
npm run deploy web        # build + verify + deploy the React app  → app.friar.fi
npm run deploy api        # deploy the API worker                  → api.friar.fi
npm run deploy indexer    # deploy the indexer (DO + 5-min cron; no public route)
npm run deploy site       # deploy the marketing landing           → friar.fi + www
npm run deploy mcp        # deploy the MCP server worker           → mcp.friar.fi
npm run deploy all        # api → indexer → mcp → web → site (backend before frontend)
```

Rehearse without shipping anything: `node scripts/deploy.mjs all --dry`.

## What it handles for you

- **Web env** — the prod URLs live in `apps/web/.env.production` (checked in; Vite loads it
  automatically for `vite build`). So the build is just `npm run build` — **no `VITE_*` on the
  command line**. The script then **verifies** the built bundle points at `api.friar.fi` and has
  no `localhost` leak before it ships. If that check fails, `.env.production` is probably missing
  or clobbered.
- **Propagation** — after a web deploy it polls `app.friar.fi` until the new asset hash is live at
  the edge. If it's still stale, the CDN usually catches up within a minute; a hard refresh
  (`Cmd+Shift+R`) bypasses the browser cache. This is the "I still see the old build" gotcha.
- **Wrangler** — uses the workspace-local `node_modules/.bin/wrangler`, run from each app's own
  directory. Auth is the machine's global OAuth; nothing to log in.

## Database schema (rare)

Applying `apps/indexer/schema.sql` to the **live remote** D1 is a separate, guarded step because
it touches production data:

```bash
node scripts/deploy.mjs db-schema --yes
```

The schema is additive (`CREATE TABLE IF NOT EXISTS …`); it won't drop or migrate existing tables.

## Beta access requests

`POST /beta/request` needs no secrets — it's live wherever `BETA_REQUESTS=on` is set (worker
`vars` + the web build's `VITE_BETA_REQUESTS`). Its defenses are the wallet signature and a
20-rows-per-minute ceiling, both in `apps/api/src/beta.ts`. Approvals:
`node scripts/beta.mjs list|approve|reject --remote`.

> Turnstile was removed 2026-07-25 — a CAPTCHA in front of a waitlist bought nothing and gave
> the funnel an invisible way to fail. The now-unused `TURNSTILE_SECRET` secret can be deleted
> with `npx wrangler secret delete TURNSTILE_SECRET` from `apps/api/`.

## Topology / provisioning

Everything Cloudflare-side (account, token scopes, D1 `friar`, custom domains, DNS) is already
provisioned. The full record — account id, token caveats (zone is read-only, so custom domains
must be **Workers** static-assets, not Pages), D1 id, and the live URLs — is in the
`reference-cloudflare-deploy` memory. `scripts/deploy.mjs` is the operational front end to it.
