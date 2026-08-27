// Beta access request — the one message format shared by the web form (signs it) and
// the API worker (recovers the signer from it). Any drift between the two breaks every
// request with a 401, so both sides import THIS builder and never inline the template.

export interface BetaRequestFields {
  address: string; // 0x… as the wallet reports it (case preserved in the signed text)
  discord: string;
  signedAt: string; // ISO-8601, produced by the client at sign time
}

export function betaRequestMessage({ address, discord, signedAt }: BetaRequestFields): string {
  return [
    "Friar beta access request",
    "",
    `wallet: ${address}`,
    `discord: ${discord}`,
    `signed at: ${signedAt}`,
    "",
    "This signature only proves wallet ownership for the beta waitlist.",
    "It authorizes no transaction and costs nothing.",
  ].join("\n");
}

// Discord usernames: 2–32 chars today; legacy name#0000 ran longer. Permissive on
// purpose — this is a contact handle for the invite DM, not an identity check.
export const DISCORD_RE = /^[^\s@#:`]{2,32}(#\d{4})?$/;

/** How stale a signed request may be before the API refuses it (replay hygiene). */
export const BETA_SIGNATURE_TTL_MS = 10 * 60 * 1000;
