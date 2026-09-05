// "Your wallet said it sent this, but the chain has never heard of it."
//
// waitForTransactionReceipt has exactly one failure message — "Timed out while waiting for
// transaction … to be confirmed" — for two completely different situations:
//
//   slow      the tx is in the mempool and we gave up early. Waiting longer fixes it.
//   vanished  the wallet returned a hash, signed, and never relayed the raw tx. Waiting is
//             pointless; nothing will ever confirm.
//
// On a 100ms-block chain with a single sequencer, "slow" barely exists, so a timeout here
// is almost always the second one. Telling them apart matters because the advice inverts:
// on 2026-09-03 a visitor signed the SAME approval three times across 70 minutes, and all
// three hashes are absent from every RPC. Their wallet's endpoint was dropping the send.
// The app said "timed out" each time, so the only thing left to try was to sign again.
//
// Probe every endpoint directly rather than through the app's fallback transport: a
// fallback client stops at the first node that answers, and "this one node hasn't seen it"
// is precisely the thing we must not conclude from.

import { createPublicClient, http } from "viem";
import { robinhoodChain } from "@friar/chain";

export type TxWhereabouts = "mined" | "pending" | "absent" | "unknown";

const isTimeout = (e: unknown): boolean =>
  /Timed out while waiting for transaction/i.test(e instanceof Error ? e.message : String(e));

/** Ask every configured RPC whether it has ever seen this hash. "absent" is only returned
 * when at least one endpoint answered and NO endpoint knew the tx — an all-errors result is
 * "unknown", because a network we cannot reach tells us nothing about what it contains. */
export async function locateTx(hash: `0x${string}`): Promise<TxWhereabouts> {
  let answered = false;
  let pending = false;
  for (const url of robinhoodChain.rpcUrls.default.http) {
    const client = createPublicClient({ chain: robinhoodChain, transport: http(url) });
    try {
      const receipt = await client.getTransactionReceipt({ hash }).catch(() => null);
      answered = true;
      if (receipt) return "mined";
      const tx = await client.getTransaction({ hash }).catch(() => null);
      if (tx) pending = true;
    } catch {
      /* endpoint unreachable — it gets no vote */
    }
  }
  if (pending) return "pending";
  return answered ? "absent" : "unknown";
}

/** Rewrite a receipt-wait timeout into what actually happened, for both audiences: the
 * returned string is shown to the user, and `action` is what the operator will grep
 * client_errors for. Any error that is not a receipt timeout passes straight through. */
export async function explainTimeout(
  e: unknown,
  hash: `0x${string}` | undefined,
): Promise<{ message: string; action?: string } | null> {
  if (!hash || !isTimeout(e)) return null;
  const where = await locateTx(hash);
  if (where === "mined") return { message: "the transaction did confirm. Reload to pick it up", action: "tx-late" };
  if (where === "pending")
    return { message: "still pending on the network, so give it a moment rather than re-signing", action: "tx-pending" };
  if (where === "unknown") return { message: "couldn't reach the network to check. Try again in a minute" };
  return {
    message:
      "your wallet reported this as sent, but the network never received it. Re-signing won't help. This is usually the wallet's own RPC endpoint for Robinhood Chain, or a wallet that doesn't support signing for apps on this chain at all.",
    action: "tx-vanished",
  };
}
