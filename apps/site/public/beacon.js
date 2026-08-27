// Funnel telemetry for the STATIC surfaces: the friar.fi landing page and /docs/*.
//
// Why this exists: the app has had telemetry since 2026-07-25 (apps/web/src/analytics.ts),
// but friar.fi itself had none. That made the biggest drop in the whole funnel invisible —
// visitors reached the landing page and we could only ever see the handful who made it all
// the way to app.friar.fi. "Nobody came" and "came, read it, left" need different fixes.
//
// Same contract and same privacy stance as the app's copy: no third-party script, no
// cookie, no ip stored server-side. `visitor` is a random id this browser invents for
// itself — enough to count people, never enough to identify one. Cleared with localStorage.
//
// NOTE ON IDENTITY: localStorage is origin-scoped, so the id minted here (friar.fi) is
// deliberately NOT the same id the app mints (app.friar.fi). These counts are aggregate.
// The docs → app join is done with ?ref= on the launch links, not by identity — which is
// why the launch links carry ?ref=site and ?ref=docs.
(function () {
  try {
    var API = "https://api.friar.fi";
    var VKEY = "friar:visitor";
    var SKEY = "friar:session";

    // crypto.randomUUID is absent in non-secure contexts and on older Safari. An unguarded
    // call would throw and take the rest of this file with it.
    function rid() {
      try {
        return crypto.randomUUID();
      } catch (e) {
        return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      }
    }

    // Storage can throw outright in private mode / with storage blocked. Telemetry must
    // never be the reason a page misbehaves, so every read falls back to a throwaway id.
    function sticky(store, key) {
      try {
        var v = store.getItem(key);
        if (!v) {
          v = rid();
          store.setItem(key, v);
        }
        return v;
      } catch (e) {
        return rid();
      }
    }

    var visitor = sticky(localStorage, VKEY);
    // sessionStorage, not a fresh id per load: the docs are a multi-page static site, so a
    // per-load id would count every click through the guide as a separate session.
    var session = sticky(sessionStorage, SKEY);

    var source;
    try {
      var sp = new URLSearchParams(location.search);
      source = sp.get("ref") || sp.get("utm_source") || undefined;
    } catch (e) {
      source = undefined;
    }

    fetch(API + "/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // keepalive so a view fired as someone navigates straight through still lands
      keepalive: true,
      body: JSON.stringify({
        name: "page_view",
        visitor: visitor,
        session: session,
        path: location.pathname,
        referrer: document.referrer || undefined,
        source: source,
      }),
    }).catch(function () {});
  } catch (e) {
    /* telemetry must never take the page down */
  }
})();
