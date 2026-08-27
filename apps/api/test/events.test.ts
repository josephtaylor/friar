import { describe, it, expect } from "vitest";
import { handleClientEvent } from "../src/events.js";

/** In-memory stand-in for the one table the funnel touches. */
function fakeDb(existingInLastMinute = 0) {
  const rows: Record<string, unknown>[] = [];
  const db = {
    rows,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (sql.includes("COUNT(*)")) return { n: existingInLastMinute };
              return null;
            },
            async run() {
              if (sql.startsWith("INSERT INTO client_events")) {
                const [ts, name, visitor, session, path, referrer, source, address, meta, ua] = args;
                rows.push({ ts, name, visitor, session, path, referrer, source, address, meta, ua });
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
  return db as typeof db & D1Database;
}

const base = { name: "page_view", visitor: "v1", session: "s1", path: "/tokens" };

describe("funnel event intake", () => {
  it("records an allowlisted event", async () => {
    const db = fakeDb();
    const out = await handleClientEvent(db, base, "Mozilla/5.0");
    expect(out.status).toBe(200);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]!.name).toBe("page_view");
    expect(db.rows[0]!.ua).toBe("Mozilla/5.0");
  });

  // Every name the client is capable of firing must be accepted here. docs_click was
  // fired from six call sites in apps/web while missing from the allowlist, so it 400'd
  // into the client's empty .catch() and recorded nothing for weeks — silent because
  // telemetry is deliberately fire-and-forget. Keep this in step with EventName in
  // apps/web/src/analytics.ts; a name in one and not the other is invisible in prod.
  it("accepts every event name the client can fire", async () => {
    for (const name of ["page_view", "wallet_connect", "open_plan", "open_success", "discord_click", "docs_click"]) {
      const db = fakeDb();
      const out = await handleClientEvent(db, { ...base, name }, undefined);
      expect(out.status, `${name} must be allowlisted`).toBe(200);
      expect(db.rows[0]!.name).toBe(name);
    }
  });

  // An open name column would let anyone write arbitrary labels into the funnel and
  // quietly poison the numbers we'd base decisions on.
  it("refuses unknown event names and writes nothing", async () => {
    const db = fakeDb();
    for (const name of ["", "whatever", "DROP TABLE", undefined]) {
      const out = await handleClientEvent(db, { ...base, name } as never, undefined);
      expect(out.status).toBe(400);
    }
    expect(db.rows).toHaveLength(0);
  });

  it("keeps only the path, never the query string", async () => {
    const db = fakeDb();
    await handleClientEvent(db, { ...base, path: "/open?token=0xdead&address=0xbeef" }, undefined);
    expect(db.rows[0]!.path).toBe("/open");
  });

  it("reduces a referrer to its origin", async () => {
    const db = fakeDb();
    await handleClientEvent(db, { ...base, referrer: "https://x.com/someone/status/123" }, undefined);
    expect(db.rows[0]!.referrer).toBe("https://x.com");

    const db2 = fakeDb();
    await handleClientEvent(db2, { ...base, referrer: "not a url" }, undefined);
    expect(db2.rows[0]!.referrer).toBeNull();
  });

  it("only stores a well-formed address, lowercased", async () => {
    const db = fakeDb();
    await handleClientEvent(db, { ...base, name: "wallet_connect", address: "0xAbC0000000000000000000000000000000000123" }, undefined);
    expect(db.rows[0]!.address).toBe("0xabc0000000000000000000000000000000000123");

    const db2 = fakeDb();
    await handleClientEvent(db2, { ...base, address: "not-an-address" }, undefined);
    expect(db2.rows[0]!.address).toBeNull();
  });

  it("caps meta and survives unserializable input", async () => {
    const db = fakeDb();
    await handleClientEvent(db, { ...base, name: "open_plan", meta: { symbol: "X".repeat(900) } }, undefined);
    expect((db.rows[0]!.meta as string).length).toBeLessThanOrEqual(400);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const db2 = fakeDb();
    const out = await handleClientEvent(db2, { ...base, meta: cyclic }, undefined);
    expect(out.status).toBe(200);
    expect(db2.rows[0]!.meta).toBeNull();
  });

  it("rate limits once the per-minute ceiling is hit", async () => {
    const db = fakeDb(600);
    const out = await handleClientEvent(db, base, undefined);
    expect(out.status).toBe(429);
    expect(db.rows).toHaveLength(0);
  });
});
