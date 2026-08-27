// "Share PnL" — the Tithe card modal. The server renders the PNG (same URL the share
// link unfurls), so the preview IS the artifact: no client-side renderer to drift.
import { useState } from "react";
import { api, type CardOpts } from "../api.js";
import { useDenom } from "../denom.js";

export function ShareCard({ id, owner, symbol, quoteSym }: { id: number; owner: string; symbol?: string; quoteSym: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>
        Share PnL
      </button>
      {open && <ShareModal id={id} owner={owner} symbol={symbol} quoteSym={quoteSym} onClose={() => setOpen(false)} />}
    </>
  );
}

function ShareModal({
  id,
  owner,
  symbol,
  quoteSym,
  onClose,
}: {
  id: number;
  owner: string;
  symbol?: string;
  quoteSym: string;
  onClose: () => void;
}) {
  const { denom } = useDenom();
  const [opts, setOpts] = useState<CardOpts>({
    metric: "percent",
    denom: quoteSym === "WETH" && denom === "USD" ? "USD" : "WETH",
    showAmounts: true,
  });
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  const cardUrl = api.cardUrl(id, owner, opts);
  const shareUrl = api.shareUrl(id, owner, opts);
  const set = (patch: Partial<CardOpts>): void => {
    setLoaded(false);
    setOpts((o) => ({ ...o, ...patch }));
  };

  const download = async (): Promise<void> => {
    setSaving(true);
    try {
      const blob = await (await fetch(cardUrl)).blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `friar-pnl-${symbol ?? id}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setSaving(false);
    }
  };

  const copy = (): void => {
    void navigator.clipboard?.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal modal-share" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Share PnL</div>
        <div className="modal-sub">pair · duration · PnL · fees — never your strategy or wallet</div>
        <img
          key={cardUrl}
          className={`share-preview${loaded ? "" : " loading"}`}
          src={cardUrl}
          alt="PnL card preview"
          onLoad={() => setLoaded(true)}
        />
        <div className="share-controls">
          <div className="denom-toggle" role="group" aria-label="featured number">
            <button className={opts.metric === "percent" ? "active" : ""} onClick={() => set({ metric: "percent" })}>
              percent
            </button>
            <button
              className={opts.metric === "amount" ? "active" : ""}
              disabled={!opts.showAmounts}
              onClick={() => set({ metric: "amount" })}
            >
              amount
            </button>
          </div>
          {quoteSym === "WETH" && (
            <div className="denom-toggle" role="group" aria-label="denomination">
              <button className={opts.denom === "WETH" ? "active" : ""} onClick={() => set({ denom: "WETH" })}>
                Ξ WETH
              </button>
              <button className={opts.denom === "USD" ? "active" : ""} onClick={() => set({ denom: "USD" })}>
                $ USD
              </button>
            </div>
          )}
          <div className="denom-toggle" role="group" aria-label="absolute amounts">
            <button className={opts.showAmounts ? "active" : ""} onClick={() => set({ showAmounts: true })}>
              amounts
            </button>
            <button
              className={!opts.showAmounts ? "active" : ""}
              onClick={() => set({ showAmounts: false, metric: "percent" })}
            >
              % only
            </button>
          </div>
        </div>
        <div className="modal-actions">
          <a
            className="btn btn-ghost-gold"
            href={`https://twitter.com/intent/tweet?url=${encodeURIComponent(shareUrl)}`}
            target="_blank"
            rel="noreferrer"
          >
            Post on 𝕏
          </a>
          <button className="btn" onClick={copy}>
            {copied ? "copied ✓" : "Copy link"}
          </button>
          <button className="btn btn-gold" disabled={saving} onClick={() => void download()}>
            {saving ? "saving…" : "Download PNG"}
          </button>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
