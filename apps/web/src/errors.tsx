// Error display + reporting. Two audiences, two payloads: the USER gets viem's one-line
// shortMessage (never the raw dump with request args / bin arrays); the OPERATOR gets the
// verbatim error shipped to POST /client-log (D1 client_errors, keyed by wallet) so a
// Discord report resolves to a query. report() is fire-and-forget and can never throw —
// telemetry must not break the flow it's observing.
import React from "react";
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";
import { getAccount } from "wagmi/actions";
import { config } from "./wagmi.js";

const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8788";

/** One human line for the UI. Walks viem's cause chain for the real reason. */
export function humanErr(e: unknown): string {
  // instanceof can miss across duplicate viem copies — duck-type as the fallback.
  const base = e instanceof BaseError ? e : null;
  if (base) {
    if (base.walk((c) => c instanceof UserRejectedRequestError)) return "rejected in wallet";
    const revert = base.walk((c) => c instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName)
      return `reverted: ${revert.data.errorName}${revert.data.args?.length ? `(${revert.data.args.map(String).join(", ")})` : ""}`;
    return base.shortMessage;
  }
  const short = (e as { shortMessage?: unknown })?.shortMessage;
  if (typeof short === "string") return short;
  const m = e instanceof Error ? e.message : String(e);
  // Some wallets reject with bare strings; viem's error walk then dies probing
  // `'data' in <string>` and the TypeError replaces the real failure. (Safari says
  // "is not an Object. (evaluating…", Chrome says "Cannot use 'in' operator".)
  if (/is not an Object\. \(evaluating|Cannot use 'in' operator/.test(m))
    return "the wallet sent back a malformed error — the tx may still have gone through, check the wallet's activity before retrying";
  return m.length > 200 ? `${m.slice(0, 200)}…` : m;
}

export interface ReportCtx {
  positionId?: number;
  poolId?: string;
  txHash?: string;
}

// Don't re-send an identical action+message inside a minute — a render loop or stuck
// retry would otherwise burn the endpoint's rate limit and drown the signal.
const recent = new Map<string, number>();

// Serialize the .cause chain — the hop that ISN'T an Error (a wallet's bare-string
// rejection) is the one that breaks viem's own walk, so it's the one worth keeping.
function causeChain(e: unknown): string {
  const hops: string[] = [];
  let cur: unknown = e instanceof Error ? e.cause : undefined;
  for (let depth = 0; cur !== undefined && cur !== null && depth < 8; depth++) {
    if (cur instanceof Error) {
      hops.push(`↳ ${cur.name}: ${cur.message.slice(0, 300)}`);
      cur = cur.cause;
    } else {
      hops.push(`↳ (non-Error ${typeof cur}) ${String(cur).slice(0, 300)}`);
      break;
    }
  }
  return hops.length ? `\n${hops.join("\n")}` : "";
}

/** Ship the verbatim error to /client-log (and the browser console). Never throws. */
export function report(action: string, e: unknown, ctx: ReportCtx = {}): void {
  try {
    console.error(`[friar:${action}]`, e);
    const message = e instanceof Error ? `${e.message}${causeChain(e)}${e.stack ? `\n${e.stack}` : ""}` : String(e);
    const key = `${action}|${message.slice(0, 200)}`;
    const now = Date.now();
    const last = recent.get(key);
    if (last !== undefined && now - last < 60_000) return;
    recent.set(key, now);
    if (recent.size > 100) recent.clear();
    void fetch(`${BASE}/client-log`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: getAccount(config).address ?? undefined,
        action,
        message,
        url: location.href,
        ...ctx,
      }),
    }).catch(() => {});
  } catch {
    /* reporting must never take the app down */
  }
}

/** window-level nets for whatever the catch blocks miss. Call once at boot. */
export function installGlobalErrorReporting(): void {
  window.addEventListener("error", (ev) => report("window.onerror", ev.error ?? ev.message));
  window.addEventListener("unhandledrejection", (ev) => report("unhandledrejection", ev.reason));
}

/** Last-resort render net — a component crash gets a reload card instead of a white
 * screen, and the stack lands in client_errors. */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { crashed: boolean }> {
  state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    const wrapped = new Error(`${error.message}\ncomponent stack:${info.componentStack ?? " (none)"}`);
    wrapped.stack = error.stack;
    report("render-crash", wrapped);
  }

  render(): React.ReactNode {
    if (!this.state.crashed) return this.props.children;
    return (
      <div className="overlay">
        <div className="modal">
          <div className="modal-title">something broke</div>
          <div className="modal-sub">the error was reported — a reload usually clears it</div>
          <div className="modal-actions">
            <button className="btn btn-gold" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
