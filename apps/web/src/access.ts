import { useAccount } from "wagmi";
import { useSearchParams } from "react-router-dom";

/** Sticky read-only viewer. The `?address=` param is fragile on mobile — bare
 * `<Navigate>` redirects drop the query, and home-screen launches re-enter without it —
 * so the last viewed address persists in sessionStorage and the param merely (re)sets
 * it. `?address=off` (or connecting a wallet) clears the sticky view. Session-scoped on
 * purpose: closing the browser ends the whale-watch instead of haunting the next visit. */
const VIEW_KEY = "friar:view";
function stickyView(param: string | null, connected: boolean): string | null {
  try {
    if (param === "off") {
      sessionStorage.removeItem(VIEW_KEY);
      return null;
    }
    if (param) {
      sessionStorage.setItem(VIEW_KEY, param);
      return param;
    }
    if (connected) return null; // a connected wallet outranks a stale sticky view
    return sessionStorage.getItem(VIEW_KEY);
  } catch {
    return param === "off" ? null : param;
  }
}

/** The invite-only beta ended 2026-07-25 — the app is open to everyone.
 *
 * What used to be here: an allowlist check (`api.allowed`) plus a `BETA_REQUESTS` launch
 * flag, gating the open flow's submit button and other wallets' position books. It was
 * removed because it was solving the wrong problem: the launch drew zero requests, so the
 * gate was a wall in front of an empty room, and the funnel telemetry that would have
 * told us so didn't exist. See DECISIONS.md (2026-07-25).
 *
 * This hook survives — with `admitted` permanently true — because a dozen components ask
 * it who the viewer is, and collapsing all of that into each call site would be a much
 * larger diff than the gate was worth. It's now purely "who am I looking at?".
 */
export function useAccess() {
  const { address, isConnected, isReconnecting } = useAccount();
  const [sp] = useSearchParams();
  return {
    address,
    isConnected,
    /** Kept for call sites that still branch on it; nobody is gated any more. */
    admitted: true,
    // ?address=0x… read-only viewer (whale-watching / sharing a book). Everything it can
    // show is public-ledger data the API serves to anyone who asks, so it is open too.
    // Sticky across navigation/redirects (see stickyView); ?address=off exits.
    viewAddress: stickyView(sp.get("address"), isConnected),
    checking: false,
    /** Still real: the wallet may be auto-reconnecting on page load, and landing
     * decisions wait on it so a returning user isn't bounced off their dashboard. */
    pending: isReconnecting,
  };
}
