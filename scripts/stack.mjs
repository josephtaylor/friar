#!/usr/bin/env node
// friar local stack controller — one command instead of three terminals.
//
//   node scripts/stack.mjs up [--seed] [--from=BLOCK]   start indexer+api+web detached
//   node scripts/stack.mjs down                         stop everything
//   node scripts/stack.mjs status                       ports, pids, indexer cursor
//   node scripts/stack.mjs logs [indexer|api|web]       print log file paths (tail -f them)
//
// Detached: survives closing the terminal. Logs in .stack/, pids in .stack/pids.json.
import { spawn, execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STACK = join(ROOT, ".stack");
const PIDS = join(STACK, "pids.json");
const START_BLOCK_DEFAULT = 12144108; // FriarPositionManager deploy block

const SERVICES = [
  { name: "indexer", cwd: join(ROOT, "apps", "indexer"), cmd: "npm", args: ["run", "dev"], port: 8790 },
  { name: "api", cwd: join(ROOT, "apps", "api"), cmd: "npm", args: ["run", "dev"], port: 8788 },
  { name: "web", cwd: join(ROOT, "apps", "web"), cmd: "npm", args: ["run", "dev"], port: 5173 },
];

const cmd = process.argv[2];
const flags = process.argv.slice(3);

if (cmd === "up") await up();
else if (cmd === "down") down();
else if (cmd === "status") await status();
else if (cmd === "logs") logs();
else {
  console.log("usage: node scripts/stack.mjs up [--seed] [--from=BLOCK] | down | status | logs");
  process.exit(1);
}

async function up() {
  mkdirSync(STACK, { recursive: true });
  down(true); // clear any stale instances first

  if (!existsSync(join(ROOT, ".wrangler-persist"))) {
    console.log("local D1 missing — applying schema…");
    execSync("npm run db:schema", { cwd: ROOT, stdio: "inherit" });
  }
  // known venues (idempotent) — powers candles + zap venue discovery
  execSync(
    "npx wrangler d1 execute friar --local --persist-to ../../.wrangler-persist --file ../../scripts/seed-venues.sql && npx wrangler d1 execute friar --local --persist-to ../../.wrangler-persist --file ../../scripts/seed-allowlist.sql",
    { cwd: join(ROOT, "apps", "indexer"), stdio: "pipe" },
  );
  if (flags.includes("--seed")) {
    console.log("seeding demo fixtures…");
    execSync("npm run db:seed", { cwd: ROOT, stdio: "inherit" });
  }

  const pids = {};
  for (const s of SERVICES) {
    const log = openSync(join(STACK, `${s.name}.log`), "a");
    const child = spawn(s.cmd, s.args, { cwd: s.cwd, detached: true, stdio: ["ignore", log, log] });
    child.unref();
    pids[s.name] = child.pid;
    console.log(`${s.name.padEnd(8)} pid ${child.pid}  :${s.port}`);
  }
  writeFileSync(PIDS, JSON.stringify(pids, null, 2));

  for (const s of SERVICES) {
    const ok = await waitPort(s.port, 30_000);
    console.log(`${s.name.padEnd(8)} ${ok ? "ready" : "NOT RESPONDING (check .stack/" + s.name + ".log)"}`);
  }

  const fromFlag = flags.find((f) => f.startsWith("--from="));
  const from = fromFlag ? Number(fromFlag.split("=")[1]) : null;
  try {
    const url = `http://localhost:8790/start${from !== null ? `?from=${from}` : ""}`;
    const res = await fetch(url);
    const body = await res.json();
    console.log(`indexer started, cursor ${body.cursor ?? "?"} (default START_BLOCK ${START_BLOCK_DEFAULT})`);
  } catch {
    console.log("indexer /start failed — kick it manually: curl localhost:8790/start");
  }

  console.log(`\n  web:     http://localhost:5173`);
  console.log(`  api:     http://localhost:8788`);
  console.log(`  indexer: http://localhost:8790/status`);
  console.log(`  logs:    tail -f ${join(STACK, "*.log")}`);
}

function down(quiet = false) {
  let pids = {};
  try {
    pids = JSON.parse(readFileSync(PIDS, "utf8"));
  } catch {}
  for (const [name, pid] of Object.entries(pids)) {
    try {
      process.kill(-pid, "SIGTERM"); // negative pid = whole process group (npm + children)
      if (!quiet) console.log(`stopped ${name} (pgid ${pid})`);
    } catch {}
  }
  // belt & suspenders: free service ports AND wrangler inspector ports (a wrangler
  // parent can survive its workerd child and squat the inspector), plus any stray
  // `wrangler dev` parents pointed at our ports.
  const ports = [...SERVICES.map((s) => s.port), 9229, 9230, 9231, 9232];
  for (const port of ports) {
    try {
      const out = execSync(`lsof -ti TCP:${port} -sTCP:LISTEN`, { encoding: "utf8" }).trim();
      for (const pid of out.split("\n").filter(Boolean)) {
        try {
          process.kill(Number(pid), "SIGKILL");
          if (!quiet) console.log(`freed :${port} (pid ${pid})`);
        } catch {}
      }
    } catch {}
  }
  try {
    execSync(`pkill -f "wrangler dev --port 8790" 2>/dev/null; pkill -f "wrangler dev --port 8788" 2>/dev/null`, {
      shell: "/bin/bash",
    });
  } catch {}
  try {
    writeFileSync(PIDS, "{}");
  } catch {}
  if (!quiet) console.log("stack down");
}

async function status() {
  for (const s of SERVICES) {
    let listening = false;
    try {
      listening = execSync(`lsof -ti TCP:${s.port} -sTCP:LISTEN`, { encoding: "utf8" }).trim().length > 0;
    } catch {}
    console.log(`${s.name.padEnd(8)} :${s.port}  ${listening ? "UP" : "down"}`);
  }
  try {
    const st = await (await fetch("http://localhost:8790/status")).json();
    console.log(`indexer cursor ${st.cursor}${st.lastError ? `  lastError: ${st.lastError}` : ""}`);
  } catch {}
}

function logs() {
  const which = flags[0];
  const names = which ? [which] : SERVICES.map((s) => s.name);
  for (const n of names) console.log(join(STACK, `${n}.log`));
}

function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = async () => {
      try {
        await fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(900) });
        return resolve(true);
      } catch (e) {
        // ECONNREFUSED = not up yet; any HTTP response (even 404) means the port answered
        if (String(e?.cause?.code ?? "").includes("ECONNREFUSED") || e.name === "TimeoutError") {
          if (Date.now() > deadline) return resolve(false);
          return setTimeout(tick, 500);
        }
        return resolve(true);
      }
    };
    tick();
  });
}
