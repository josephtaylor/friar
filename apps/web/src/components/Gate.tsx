import { useState } from "react";
import { useAccount, useConnect } from "wagmi";

/** Wallet-connection UI. This file used to hold the invite-only beta's gates
 * (BetaBanner / OpenGate / PrivateGate); the beta ended 2026-07-25 and they're gone —
 * nothing here refuses anyone now. What's left is the connect affordance and the
 * walletless empty state. */

/** Phantom is blocked at the door (2026-08-02): its security backend can't read
 * Robinhood Chain, so it flags the verified manager as "an EOA" with a red full-screen
 * warning and, past that, its transaction simulation fails valid sends outright.
 * Reported to Phantom; until it's fixed, letting a Phantom user connect just walks them
 * into a scare screen mid-open. Remove this (and the modal note below) when Phantom's
 * chain support works. */
const isPhantom = (c: { id: string; name: string }) => c.id === "app.phantom" || /phantom/i.test(c.name);

/** The wallet chooser — one entry per detected wallet (EIP-6963 discovery). Always
 * reached through a single connect button + this modal, everywhere in the app. */
function WalletModal({ onClose }: { onClose: () => void }) {
  const { connect, connectors } = useConnect();
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Connect a wallet</div>
        {connectors.length === 0 ? (
          <div className="gate-note">no wallet extension detected</div>
        ) : (
          <div className="gate-wallets">
            {connectors.map((c) =>
              isPhantom(c) ? (
                <div key={c.uid} className="gate-wallet blocked">
                  {c.icon && <img src={c.icon} alt="" className="wallet-icon" style={{ margin: 0 }} />}
                  {c.name}
                  <span className="gate-wallet-tag">unavailable</span>
                </div>
              ) : (
                <button key={c.uid} className="gate-wallet" onClick={() => connect({ connector: c })}>
                  {c.icon && <img src={c.icon} alt="" className="wallet-icon" style={{ margin: 0 }} />}
                  {c.name}
                </button>
              ),
            )}
          </div>
        )}
        {connectors.some(isPhantom) && (
          <div className="gate-note">
            Phantom's Robinhood Chain support is incomplete right now: it blocks valid transactions
            on this chain. We've reported it to Phantom. Meanwhile Trust, MetaMask, and Rabby all
            work, or open app.friar.fi inside another wallet's browser.
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** Single connect affordance: a button that opens the wallet chooser. `className`
 * styles the button for its slot (topbar chip, big gold submit, …). Unmounts of the
 * parent on successful connect take the modal down with them. */
export function ConnectButton({ label = "Connect wallet", className = "btn btn-gold" }: { label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={className} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open && <WalletModal onClose={() => setOpen(false)} />}
    </>
  );
}

/** Topbar connect affordance for walletless visitors. */
export function ConnectChip() {
  const { isConnected } = useAccount();
  if (isConnected) return null;
  return <ConnectButton label="connect" className="wallet" />;
}

/** Walletless empty state for the owner-keyed screens (positions / history). */
export function ConnectScreen({ msg }: { msg: string }) {
  return (
    <div className="gate" style={{ minHeight: "50vh" }}>
      <div className="gate-msg">{msg}</div>
      <ConnectButton />
    </div>
  );
}
