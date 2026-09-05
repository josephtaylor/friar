import { useState } from "react";
import { useAccount, useConnect } from "wagmi";
import { isPhantomBrowser, isPhantomConnector, isPhantomBlocked } from "../wallet.js";

/** Wallet-connection UI. This file used to hold the invite-only beta's gates
 * (BetaBanner / OpenGate / PrivateGate); the beta ended 2026-07-25 and they're gone —
 * nothing here refuses anyone now. What's left is the connect affordance and the
 * walletless empty state. */

/** Phantom's desktop extension is blocked at the door (2026-08-02): Phantom does not
 * support connecting to apps on Robinhood Chain at all, so a Phantom user who connects
 * walks into a scare screen and then signs approvals their wallet never relays. See
 * ../wallet.js for the citation and for why Phantom's mobile in-app browser is the one
 * exception that IS let through. PhantomWarning in App.tsx is the other half of this: it
 * catches a connection that never came through this door. */
const isPhantom = isPhantomBlocked;

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
        {isPhantomBrowser() ? (
          <div className="gate-note">
            Heads up: Phantom doesn't officially support connecting to apps on Robinhood Chain, so
            some transactions can be signed and never confirm. Its mobile browser does usually work
            here, and you can carry on. If something stalls, that's why.
          </div>
        ) : (
          connectors.some(isPhantomConnector) && (
            <div className="gate-note">
              Phantom doesn't support connecting to apps on Robinhood Chain. That's Phantom's own
              documented limit, not a Friar one: transactions get signed and then never reach the
              network. Trust, MetaMask, and Rabby all work here, or open app.friar.fi inside
              Phantom's mobile browser, which does.
            </div>
          )
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
