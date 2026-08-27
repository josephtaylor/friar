#!/usr/bin/env node
// friar prod deploy — one command so a fresh session never re-learns the ritual.
//
//   node scripts/deploy.mjs web       build (.env.production) + verify + deploy → app.friar.fi
//   node scripts/deploy.mjs api       deploy the API worker                     → api.friar.fi
//   node scripts/deploy.mjs indexer   deploy the indexer worker (DO + 5-min cron; no public route)
//   node scripts/deploy.mjs site      deploy the marketing landing              → friar.fi + www
//   node scripts/deploy.mjs mcp       deploy the MCP server worker              → mcp.friar.fi
//   node scripts/deploy.mjs all       api → indexer → mcp → web → site (backend before frontend)
//   node scripts/deploy.mjs db-schema apply schema.sql to the REMOTE D1 (rare, additive) — needs --yes
//
//   flags:  --dry   print every step, run nothing
//           --yes   required for db-schema (touches the live database)
//
// What this encodes so you don't have to rediscover it:
//   • The web app's prod URLs live in apps/web/.env.production (auto-loaded by `vite build`),
//     so the build is just `npm run build` — no VITE_* needed on the command line. We still
//     VERIFY the built bundle points at api.friar.fi (never localhost) before shipping.
//   • Wrangler auth is the machine's global OAuth; the binary is
//     the workspace-local node_modules/.bin/wrangler. All Cloudflare resources (D1, custom
//     domains, DNS) are already provisioned — see the reference-cloudflare-deploy memory.
//   • After a web deploy we poll the edge until the new asset hash is live (CDN can lag a few
//     seconds — that's the "still seeing the old build" gotcha).

import { execSync, execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WRANGLER = join(ROOT, "node_modules", ".bin", "wrangler");
const PROD_API = "https://api.friar.fi";
const LOCAL_MARKERS = ["localhost:8788", "localhost:8790", "127.0.0.1:8788"];

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const YES = argv.includes("--yes");
const positional = argv.filter((a) => !a.startsWith("--"));
const cmd = positional[0];

// dir is relative to ROOT; url is the public URL to sanity-check after deploy (null = private).
const APPS = {
  api: { dir: "apps/api", name: "friar-api", url: "https://api.friar.fi" },
  indexer: { dir: "apps/indexer", name: "friar-indexer", url: null },
  web: { dir: "apps/web", name: "friar-web", url: "https://app.friar.fi" },
  site: { dir: "apps/site", name: "friar-landing", url: "https://friar.fi" },
  mcp: { dir: "apps/mcp", name: "friar-mcp", url: "https://mcp.friar.fi" },
};

const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usage() {
  console.log(
    [
      "friar prod deploy",
      "",
      "  node scripts/deploy.mjs web       build + verify + deploy the React app",
      "  node scripts/deploy.mjs api       deploy the API worker",
      "  node scripts/deploy.mjs indexer   deploy the indexer worker",
      "  node scripts/deploy.mjs site      deploy the marketing landing",
      "  node scripts/deploy.mjs mcp       deploy the MCP server worker",
      "  node scripts/deploy.mjs all       api → indexer → mcp → web → site",
      "  node scripts/deploy.mjs db-schema apply schema.sql to REMOTE D1 (needs --yes)",
      "",
      "  flags: --dry (rehearse, run nothing)   --yes (confirm db-schema)",
    ].join("\n"),
  );
}

// Run a shell command from `cwd`, streaming output. Honors --dry.
function sh(command, cwd = ROOT) {
  console.log(c.dim(`  $ ${command}${cwd !== ROOT ? `   (in ${cwd.replace(ROOT + "/", "")})` : ""}`));
  if (DRY) return;
  execSync(command, { cwd, stdio: "inherit" });
}

// Wrangler from the app's own dir (so ./dist and the config resolve as expected).
function wrangler(appDir, args) {
  const cwd = join(ROOT, appDir);
  console.log(c.dim(`  $ wrangler ${args.join(" ")}   (in ${appDir})`));
  if (DRY) return "";
  return execFileSync(WRANGLER, args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
}

function preflight() {
  try {
    const branch = execSync("git branch --show-current", { cwd: ROOT }).toString().trim();
    const sha = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
    const dirty = execSync("git status --porcelain", { cwd: ROOT }).toString().trim();
    console.log(c.bold("friar deploy") + c.dim(`  ·  ${branch} @ ${sha}${dirty ? c.yellow("  ·  uncommitted changes") : ""}`));
  } catch {
    console.log(c.bold("friar deploy"));
  }
  if (!existsSync(WRANGLER)) fail(`wrangler not found at ${WRANGLER} — run \`npm install\` from ${ROOT}`);
  if (DRY) console.log(c.yellow("  (--dry: nothing will actually run)"));
  console.log();
}

function fail(msg) {
  console.error(c.red(`✗ ${msg}`));
  process.exit(1);
}

// Guard: the built bundle must talk to prod, never a dev server.
function verifyWebBundle() {
  if (DRY) return console.log(c.dim("  (--dry: would verify dist points at api.friar.fi)"));
  const assets = join(ROOT, "apps/web/dist/assets");
  if (!existsSync(assets)) return fail("apps/web/dist/assets missing — build did not produce output");
  const js = readdirSync(assets).filter((f) => f.endsWith(".js"));
  const blob = js.map((f) => readFileSync(join(assets, f), "utf8")).join("");
  const leaked = LOCAL_MARKERS.filter((m) => blob.includes(m));
  if (leaked.length) return fail(`built bundle points at a dev server (${leaked.join(", ")}) — is apps/web/.env.production intact?`);
  if (!blob.includes("api.friar.fi")) return fail("built bundle has no reference to api.friar.fi — check apps/web/.env.production");
  console.log(c.green("  ✓ bundle verified → api.friar.fi, no localhost leaks"));
}

// The asset filename vite baked into index.html — used to confirm the edge is serving it.
function webAssetHash() {
  const html = readFileSync(join(ROOT, "apps/web/dist/index.html"), "utf8");
  return html.match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null;
}

async function propagationCheck(url, asset) {
  if (DRY || !asset) return;
  process.stdout.write(c.dim(`  polling ${url} for ${asset} `));
  for (let i = 0; i < 6; i++) {
    try {
      const html = await fetch(url, { cache: "no-store" }).then((r) => r.text());
      if (html.includes(asset)) {
        console.log(c.green("→ live ✓"));
        return;
      }
    } catch {
      /* transient — keep polling */
    }
    process.stdout.write(c.dim("."));
    await sleep(2500);
  }
  console.log(c.yellow("\n  still stale at the edge — CDN usually catches up within a minute; hard-refresh (Cmd+Shift+R) to bypass browser cache"));
}

async function deployApp(key) {
  const app = APPS[key];
  if (!app) return fail(`unknown target "${key}" — one of: ${Object.keys(APPS).join(", ")}, all, db-schema`);
  console.log(c.bold(`▸ ${app.name}`) + (app.url ? c.dim(`  → ${app.url}`) : c.dim("  (private)")));

  if (key === "web") {
    sh("npm run build -w @friar/web"); // .env.production supplies the prod URLs
    verifyWebBundle();
  }

  // Docs are markdown in apps/site/docs rendered into apps/site/public/docs. Building here
  // rather than by hand means a deploy can never ship stale html against edited sources.
  if (key === "site") sh("node apps/site/scripts/build-docs.mjs");

  wrangler(app.dir, ["deploy"]);

  if (key === "web") await propagationCheck(app.url, webAssetHash());
  console.log(c.green(`  ✓ ${app.name} deployed\n`));
}

async function dbSchemaRemote() {
  console.log(c.bold("▸ remote D1 schema") + c.dim("  (friar, --remote)"));
  if (!YES) return fail("db-schema touches the LIVE database — re-run with --yes to confirm");
  sh(`${JSON.stringify(WRANGLER)} d1 execute friar --remote --file schema.sql`, join(ROOT, "apps/indexer"));
  console.log(c.green("  ✓ schema applied to remote D1\n"));
}

async function main() {
  if (!cmd || cmd === "help" || cmd === "--help") return usage();
  preflight();

  if (cmd === "db-schema") return dbSchemaRemote();

  // backend before frontend so the app never ships against a stale API
  const order = cmd === "all" ? ["api", "indexer", "mcp", "web", "site"] : [cmd];
  for (const key of order) await deployApp(key);

  console.log(c.green(c.bold("done ✓")));
}

main().catch((e) => fail(e?.message ?? String(e)));
