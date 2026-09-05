import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useAccount, useDisconnect } from "wagmi";
import { Routes, Route, Navigate, Outlet, useNavigate, useLocation, useParams, useSearchParams } from "react-router-dom";
import { Shell, type NavKey } from "./components/Shell.js";
import { ConnectChip, ConnectScreen } from "./components/Gate.js";
import { Dashboard } from "./components/Dashboard.js";
import { PositionDetail } from "./components/PositionDetail.js";
import { OpenPosition } from "./components/OpenPosition.js";
import { Tokens } from "./components/Tokens.js";
import { Pools } from "./components/Pools.js";
import { History } from "./components/History.js";
import { StepperProvider } from "./components/StepperHost.js";
import { shortAddr } from "./tokens.js";
import { useAccess } from "./access.js";
import { track, trackWalletConnect } from "./analytics.js";
import { connectorIsPhantom, isPhantomBrowser } from "./wallet.js";

/** Where a screen was entered from, so its crumb can name the way back. Carried in the URL
 * (?from=) rather than in state because a screen is also reachable by a shared link or a
 * reload, and a crumb that says "Positions" to someone who arrived from Tokens is worse than
 * no crumb at all. */
export type From = "tokens" | "pools" | "positions" | "history";
const FROM_LABEL: Record<From, string> = { tokens: "Tokens", pools: "Pools", positions: "Positions", history: "History" };
const FROM_PATH: Record<From, string> = { tokens: "/tokens", pools: "/pools", positions: "/", history: "/history" };
/** Deep links with no ?from land on Tokens, which is also where a walletless visitor lands. */
const readFrom = (v: string | null): From =>
  v === "positions" || v === "history" || v === "pools" ? v : "tokens";

/** navigate() that preserves the cross-cutting query params — ?address (read-only
 * whale-watching) and ?dev (local gate bypass) — across path changes, so they
 * survive clicking around. Pass a plain path like "/pools" or "/open?token=0x…". */
function useKeepNavigate() {
  const navigate = useNavigate();
  const [sp] = useSearchParams();
  return useCallback(
    (to: string) => {
      const [path = to, query] = to.split("?");
      const merged = new URLSearchParams(query);
      for (const k of ["address", "dev"]) {
        const v = sp.get(k);
        if (v && !merged.has(k)) merged.set(k, v);
      }
      const qs = merged.toString();
      navigate(qs ? `${path}?${qs}` : path);
    },
    [navigate, sp],
  );
}

/** The crumb is a BACK button, not a link to a fixed screen: when there's an in-app entry
 * behind us it pops, so Tokens → open → back leaves you where you started instead of pushing
 * a third entry and making the browser's own Back walk *forwards* into the screen you just
 * left. `key === "default"` means this is the tab's first entry (deep link, reload, fresh
 * open) — nothing to pop, so fall back to the origin's path. */
function useBack(from: From) {
  const navigate = useNavigate();
  const go = useKeepNavigate();
  const { key } = useLocation();
  return useCallback(() => {
    if (key !== "default") navigate(-1);
    else go(FROM_PATH[from]);
  }, [key, navigate, go, from]);
}

export function App() {
  const { address: connectedAddress, connector } = useAccount();
  const { disconnect } = useDisconnect();
  const location = useLocation();
  const [sp] = useSearchParams();

  const { pending, viewAddress } = useAccess();
  const navigate = useNavigate();

  // Landing default: walletless visitors start on Tokens (something to look at), not an
  // empty Positions screen. Waits for auto-reconnect to settle so a returning wallet
  // isn't bounced off its dashboard; one-shot, so clicking "Positions" afterward sticks.
  const landed = useRef(false);
  useEffect(() => {
    if (pending || landed.current) return;
    landed.current = true;
    if (!connectedAddress && location.pathname === "/") navigate("/tokens", { replace: true });
  }, [pending, connectedAddress, location.pathname, navigate]);

  // Funnel: one page_view per real navigation (the helper collapses same-path repeats),
  // and one wallet_connect the first time each address appears in this tab.
  useEffect(() => {
    track("page_view");
  }, [location.pathname]);
  useEffect(() => {
    if (connectedAddress) trackWalletConnect(connectedAddress, connector);
  }, [connectedAddress, connector]);

  // read-only viewer: ?address=0x… shows any wallet's book. Open to anyone — it can only
  // ever render public-ledger data the API already serves to every caller.
  const viewParam = viewAddress;
  const address = viewParam ?? connectedAddress;

  // nav highlight derives from the path (a position keeps its origin tab lit via ?from)
  const path = location.pathname;
  const active: NavKey | "none" = path.startsWith("/tokens")
    ? "tokens"
    : path.startsWith("/pools")
      ? "pools"
      : path.startsWith("/history")
        ? "history"
        : path.startsWith("/access")
          ? "none"
          : path.startsWith("/position") && sp.get("from") === "history"
            ? "history"
            : "positions";

  const walletChip = address ? (
    <button className="wallet" onClick={() => disconnect()} title={viewParam ? "viewing (read-only)" : "disconnect"}>
      {viewParam ? "👁 " : ""}
      {shortAddr(address)}
    </button>
  ) : (
    <ConnectChip />
  );

  return (
    <StepperProvider>
      <Routes>
        <Route element={<ShellLayout active={active} wallet={walletChip} brandTo={address ? "/" : "/tokens"} />}>
          <Route
            index
            element={address ? <DashboardRoute owner={address} /> : <ConnectScreen msg="connect a wallet to see your positions" />}
          />
          <Route path="tokens" element={<TokensRoute />} />
          <Route path="pools" element={<PoolsRoute />} />
          <Route
            path="history"
            element={address ? <HistoryRoute owner={address} /> : <ConnectScreen msg="connect a wallet to see your history" />}
          />
          <Route path="position/:id" element={<PositionRoute />} />
          <Route path="open" element={<OpenRoute />} />
          {/* the beta gate is gone; old links (launch thread, Discord) still land somewhere */}
          <Route path="access" element={<Navigate to="/tokens" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </StepperProvider>
  );
}

/** The half of the Phantom block that the wallet chooser cannot do (2026-09-03).
 *
 * Gate.tsx greys out the Phantom BUTTON, which only helps someone who connects through
 * that door on that render. It does nothing for a session persisted from before the block
 * shipped, and nothing for a provider that declines to call itself Phantom — Phantom
 * injecting as the generic window.ethereum, or its mobile in-app browser, which is how the
 * only outside position this app has ever had was opened. So ask the live provider, which
 * sets `isPhantom` on itself whatever name it announced, and say so plainly instead of
 * letting someone sign approvals that their wallet will never relay.
 *
 * A warning, not a forced disconnect: wagmi reconnects on its own, so disconnecting here
 * fights the reconnect and loops. Delete with the rest of the Phantom handling. */
function PhantomWarning() {
  const { connector, isConnected } = useAccount();
  const [flagged, setFlagged] = useState(false);
  useEffect(() => {
    let live = true;
    if (!isConnected) {
      setFlagged(false);
      return;
    }
    void connectorIsPhantom(connector).then((v) => live && setFlagged(v));
    return () => {
      live = false;
    };
  }, [connector, isConnected]);
  if (!flagged) return null;
  // Two audiences, two messages. In Phantom's mobile browser the user is allowed to carry
  // on (it works in practice), so the note prepares them for a stall rather than sending
  // them away. On the extension there is nothing to do but switch wallets.
  return (
    <div className="phantom-warn">
      {isPhantomBrowser() ? (
        <>
          <strong>You're in Phantom's browser.</strong> Phantom doesn't officially support connecting
          to apps on Robinhood Chain, so a transaction can occasionally be signed and never confirm.
          This usually works anyway, so carry on. If something stalls, that's the reason, and Trust,
          MetaMask or Rabby will get you through.
        </>
      ) : (
        <>
          <strong>Phantom can't sign for apps on Robinhood Chain.</strong> That's Phantom's own
          documented limit, not a Friar one: a transaction gets signed and then never reaches the
          network. Trust, MetaMask and Rabby all work here, or open app.friar.fi inside Phantom's
          mobile browser.
        </>
      )}
    </div>
  );
}

/** Shared chrome around the routed screens; nav buttons keep the preserved params.
 * brandTo: the wordmark lands walletless visitors on Tokens, not an empty Positions. */
function ShellLayout({ active, wallet, brandTo }: { active: NavKey | "none"; wallet: ReactNode; brandTo: string }) {
  const go = useKeepNavigate();
  return (
    <Shell
      active={active}
      onNav={(k) => go(k === "tokens" ? "/tokens" : k === "pools" ? "/pools" : k === "history" ? "/history" : "/")}
      onBrand={() => go(brandTo)}
      // the header button is on every screen, so it carries the tab you left with it
      onOpen={() => go(`/open?from=${active === "none" ? "positions" : active}`)}
      wallet={wallet}
    >
      <PhantomWarning />
      <Outlet />
    </Shell>
  );
}

function DashboardRoute({ owner }: { owner: string }) {
  const go = useKeepNavigate();
  return (
    <Dashboard
      owner={owner}
      onSelect={(id) => go(`/position/${id}`)}
      onHistory={() => go("/history")}
      onTokens={() => go("/tokens")}
      onOpen={() => go("/open")}
    />
  );
}

function TokensRoute() {
  const go = useKeepNavigate();
  return (
    <Tokens
      onOpen={(token, quote) => go(`/open?token=${token}${quote === "USDG" ? "&quote=USDG" : ""}&from=tokens`)}
    />
  );
}

function PoolsRoute() {
  const go = useKeepNavigate();
  return (
    <Pools
      onOpen={(token, quote, poolId) =>
        go(`/open?token=${token}${quote === "USDG" ? "&quote=USDG" : ""}&pool=${poolId}&from=pools`)
      }
    />
  );
}

function HistoryRoute({ owner }: { owner: string }) {
  const go = useKeepNavigate();
  return <History owner={owner} onSelect={(id) => go(`/position/${id}?from=history`)} />;
}

function PositionRoute() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const numId = Number(id);
  // hooks must run unconditionally, so resolve the crumb before the id guard bails
  const from = sp.get("from") === "history" ? "history" : "positions";
  const back = useBack(from);
  if (!Number.isInteger(numId)) return <Navigate to="/" replace />;
  return <PositionDetail id={numId} from={from} onBack={back} />;
}

function OpenRoute() {
  const go = useKeepNavigate();
  const [sp] = useSearchParams();
  const from = readFrom(sp.get("from"));
  const back = useBack(from);
  // land on the freshly-opened position's detail page; fall back to the list if the
  // indexer didn't return an id (unreachable / no PositionOpened event parsed)
  return (
    <OpenPosition
      prefillToken={sp.get("token") ?? undefined}
      prefillQuote={sp.get("quote") === "USDG" ? "USDG" : undefined}
      prefillPool={sp.get("pool") ?? undefined}
      backLabel={FROM_LABEL[from]}
      onBack={back}
      onDone={(id) => go(id !== undefined ? `/position/${id}?from=positions` : "/")}
    />
  );
}
