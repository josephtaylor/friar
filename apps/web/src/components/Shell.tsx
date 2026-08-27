import type { ReactNode } from "react";
import { DenomToggle } from "../denom.js";
import { DISCORD_INVITE, DOCS } from "../links.js";
import { track } from "../analytics.js";

export type NavKey = "positions" | "tokens" | "pools" | "history";

/* Inline rather than an icon dependency: two glyphs don't justify a package, and inline
 * paths inherit currentColor so they track .icon-link's hover with the rest of the bar.
 * aria-hidden on the svg because the accessible name belongs on the link — otherwise a
 * screen reader announces the graphic separately from the label. */
function DocsIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.3 1.8H4.2a1.5 1.5 0 0 0-1.5 1.5v9.4a1.5 1.5 0 0 0 1.5 1.5h7.6a1.5 1.5 0 0 0 1.5-1.5V5.8z" />
      <path d="M9.3 1.8v4h4" />
      <path d="M5.6 8.9h4.8M5.6 11.3h3.2" />
    </svg>
  );
}

function DiscordIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.65 12.65 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.058a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .078-.011c3.928 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .079.01c.12.099.246.198.373.292a.077.077 0 0 1-.006.128c-.598.349-1.22.65-1.873.891a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.029 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.055c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.029zM8.02 15.331c-1.183 0-2.157-1.086-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.211 0 2.176 1.095 2.157 2.419 0 1.333-.956 2.419-2.157 2.419zm7.975 0c-1.183 0-2.157-1.086-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.419 0 1.333-.946 2.419-2.157 2.419z" />
    </svg>
  );
}

/** Shared chrome: top bar (wordmark · nav · docs/discord icons · +Open · wallet), main,
 * mobile bottom nav. Wallet is always top-right. active "none" lights no tab (e.g.
 * /access). Docs and Discord are secondary destinations rather than core actions, so they
 * ride the top bar as icons at every width instead of taking two of six slots in the
 * mobile bottom nav, which left that bar too crowded to read. */
export function Shell({
  active,
  onNav,
  onBrand,
  onOpen,
  wallet,
  children,
}: {
  active: NavKey | "none";
  onNav: (k: NavKey) => void;
  onBrand: () => void;
  onOpen: () => void;
  wallet: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={onBrand}>
          FRIAR
        </button>
        <nav className="nav">
          <button className={`nav-item ${active === "tokens" ? "active" : ""}`} onClick={() => onNav("tokens")}>
            Tokens
          </button>
          <button className={`nav-item ${active === "pools" ? "active" : ""}`} onClick={() => onNav("pools")}>
            Pools
          </button>
          <button className={`nav-item ${active === "positions" ? "active" : ""}`} onClick={() => onNav("positions")}>
            Positions
          </button>
          <button className={`nav-item ${active === "history" ? "active" : ""}`} onClick={() => onNav("history")}>
            History
          </button>
        </nav>
        <div className="topbar-right">
          <a
            className="icon-link"
            href={DOCS}
            target="_blank"
            rel="noreferrer"
            onClick={() => track("docs_click")}
            aria-label="Documentation"
            title="How Friar works, and how to use it"
          >
            <DocsIcon />
          </a>
          <a
            className="icon-link"
            href={DISCORD_INVITE}
            target="_blank"
            rel="noreferrer"
            onClick={() => track("discord_click")}
            aria-label="Discord"
            title="Friar Discord"
          >
            <DiscordIcon />
          </a>
          <DenomToggle />
          <button className="btn btn-gold" onClick={onOpen}>
            + Open position
          </button>
          {wallet}
        </div>
      </header>
      <main className="main">{children}</main>
      <nav className="botnav mobile-only">
        <button className={`botnav-item ${active === "tokens" ? "active" : ""}`} onClick={() => onNav("tokens")}>
          Tokens
        </button>
        <button className={`botnav-item ${active === "pools" ? "active" : ""}`} onClick={() => onNav("pools")}>
          Pools
        </button>
        <button className="botnav-fab" onClick={onOpen} aria-label="Open position">
          +
        </button>
        <button className={`botnav-item ${active === "positions" ? "active" : ""}`} onClick={() => onNav("positions")}>
          Positions
        </button>
        <button className={`botnav-item ${active === "history" ? "active" : ""}`} onClick={() => onNav("history")}>
          History
        </button>
      </nav>
    </div>
  );
}
