// The board's numbers, for the token you just pasted into the creation screen.
//
// The gap this closes: you could always paste a contract address here and open a
// position, but the screen said nothing about whether that was a good idea. Every figure
// needed to judge it already existed on the Tokens board — it just wasn't reachable for a
// token the board had never listed. Same endpoint, same fold, same fee/TVL definition.
import { useQuery } from "@tanstack/react-query";
import { api, fmtUsd, fmtFeePct, fmtPct, type ApiToken } from "../api.js";
import { feeTvlDisplay, incumbentGap } from "../tokenStats.js";

/** Why fee/TVL is blank, in words rather than a dash. "dynamic-only" is the interesting
 * one: the token HAS a venue, that venue just prices like we do, so there is no static
 * tier to undercut and the comparison the board makes doesn't apply. */
const GAP_NOTE: Record<ReturnType<typeof incumbentGap>, string | null> = {
  none: null,
  "no-venue": "no existing venue — your open creates the first pool",
  "dynamic-only": "incumbent is a dynamic-fee pool — no static tier to compare against",
  unresolved: "incumbent fee unresolved",
};

function Stat({ label, value, tone }: { label: string; value: string; tone?: "green" | "warn" | "dim" }) {
  return (
    <div className="tm-stat">
      <span className="tm-k">{label}</span>
      <span className={`tm-v ${tone ?? ""}`}>{value}</span>
    </div>
  );
}

/**
 * Market context for `address`. Renders nothing at all until there is something to say —
 * this sits directly above the amount inputs, and a permanent loading skeleton there
 * would read as the form being broken rather than as data arriving.
 */
export function TokenMarket({ address }: { address: string }) {
  const q = useQuery({
    queryKey: ["token", address.toLowerCase()],
    queryFn: () => api.token(address),
    staleTime: 60_000,
    retry: 1,
  });

  if (q.isLoading || q.isError) return null;
  const t: ApiToken | null = q.data?.token ?? null;

  // Well-formed token, no venue anywhere. Worth saying plainly: it's the first-LP case,
  // not a failure, and it's the one situation where there is nothing to compare against.
  if (!t) {
    return (
      <div className="token-market">
        <div className="tm-note mono">no venue for this token yet — your open creates the first pool</div>
      </div>
    );
  }

  // Label follows the unit, not the other way round: with no incumbent tier this is
  // turnover, not fee/TVL, and calling it FEE/TVL would inflate it by the fee rate.
  const ftv = feeTvlDisplay(t, "24h");
  const gap = GAP_NOTE[incumbentGap(t)];

  return (
    <div className="token-market">
      <div className="tm-row">
        <Stat label="VOL 24H" value={fmtUsd(t.vol24)} />
        <Stat label="LIQ" value={fmtUsd(t.liq_usd)} />
        <Stat label="MCAP" value={fmtUsd(t.mcap)} />
        <Stat
          label="24H"
          value={fmtPct(t.ch24)}
          tone={t.ch24 == null ? "dim" : t.ch24 >= 0 ? "green" : "warn"}
        />
        <Stat
          label={ftv.kind === "turnover" ? "TURNOVER 24H" : "FEE/TVL 24H"}
          value={ftv.text}
          tone={ftv.kind === "fee" ? undefined : "dim"}
        />
        <Stat
          label="INCUMBENT"
          value={t.incumbent_fee == null ? "—" : fmtFeePct(t.incumbent_fee)}
          tone={t.incumbent_fee == null ? "dim" : undefined}
        />
      </div>
      {/* No "Friar undercuts the incumbent" line here on purpose. Our own flow data says
          the fee differential has almost nothing to do with where routers send flow —
          depth at the touch does. Selling the undercut would be selling the wrong
          mechanism, and it would set up the LP to expect volume that a cheaper fee alone
          was never going to bring. The incumbent tier stays as a fact above, because
          fee/TVL is computed from it; it just isn't a pitch. */}
      {gap && <div className="tm-note dim mono">{gap}</div>}
      {q.data?.source === "live" && (
        <div className="tm-note dim mono">not on the Tokens board — resolved from its venues just now</div>
      )}
    </div>
  );
}
