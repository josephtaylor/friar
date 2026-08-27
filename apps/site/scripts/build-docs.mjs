#!/usr/bin/env node
// Renders apps/site/docs/*.md into apps/site/public/docs/*.html.
//
//   node apps/site/scripts/build-docs.mjs
//
// Deliberately not a docs framework. The site is Workers static assets with no build step,
// and this keeps it that way: markdown in, static html out, one shared layout, one
// dependency (marked). Adding a page means adding a .md file and a line to PAGES.
//
// SOURCES ARE NOT PUBLISHED. Only apps/site/public is served — `assets.directory` used to be
// "." which meant friar.fi/scripts/… and friar.fi/wrangler.jsonc were live. Keep sources out
// of public/ and that stays true.
//
// Diagrams: generated as SVG by the make-*-png scripts with --format=svg into
// public/docs/img/. They carry their own dark palette, so figures sit on a fixed dark panel
// in both themes, the way a chart does.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "../docs");
const OUT = join(here, "../public/docs");

// Order is the reading order, and it drives both the sidebar and prev/next.
//
// TWO SECTIONS, and the user guide comes first on purpose. The original order opened with
// "is this a drainer", which answered the question a sceptic asks before touching the app
// but left someone who had already decided to use it with no page that says which button
// to press. "How do I use this" is what most people arrive with.
//
// Same reasoning inside "How it works": the mechanism pages (what a bin is, how the fee
// moves, what it costs) come before the custody one. Anyone who wants the custody answer
// goes looking for it; nobody has to read past it to reach the parts that explain the
// product.
const SECTIONS = [
  {
    title: null,
    pages: [{ slug: "index", title: "Docs", nav: "Overview" }],
  },
  {
    title: "User guide",
    pages: [
      { slug: "guide-start", title: "Getting started", nav: "Getting started" },
      { slug: "guide-tokens", title: "The Tokens board", nav: "The Tokens board" },
      { slug: "guide-pools", title: "The Friar Pools page", nav: "The Friar Pools page" },
      // keeps the /docs/opening URL that's already linked from the app and Discord
      { slug: "opening", title: "Opening a position", nav: "Opening a position" },
      { slug: "guide-position", title: "Your position page", nav: "Your position page" },
      { slug: "guide-fees", title: "Collecting fees", nav: "Collecting fees" },
      { slug: "guide-close", title: "Closing a position", nav: "Closing a position" },
      { slug: "guide-history", title: "Positions and history", nav: "Positions & history" },
    ],
  },
  {
    title: "How it works",
    pages: [
      { slug: "shapes", title: "Positions, bins and shapes", nav: "Positions & shapes" },
      { slug: "fees", title: "How the fee is set", nav: "How the fee is set" },
      { slug: "costs", title: "What Friar charges", nav: "What Friar charges" },
      { slug: "anatomy", title: "Where your money sits", nav: "Where your money sits" },
      { slug: "range", title: "When price leaves your range", nav: "When it goes wrong" },
    ],
  },
];

// prev/next runs straight through the sections, so the pager walks the whole book
const PAGES = SECTIONS.flatMap((s) => s.pages);

const site = (p) => `/docs/${p === "index" ? "" : p}`;

function layout({ title, body, slug }) {
  const nav = SECTIONS.flatMap((s) => [
    ...(s.title ? [`<div class="side-sec">${s.title}</div>`] : []),
    ...s.pages.map(
      (p) => `<a class="nav-item${p.slug === slug ? " active" : ""}" href="${site(p.slug)}">${p.nav}</a>`,
    ),
  ]).join("\n        ");
  const i = PAGES.findIndex((p) => p.slug === slug);
  const prev = i > 0 ? PAGES[i - 1] : null;
  const next = i < PAGES.length - 1 ? PAGES[i + 1] : null;
  const pager = [
    prev ? `<a class="pager prev" href="${site(prev.slug)}"><span>previous</span>${prev.nav}</a>` : `<span></span>`,
    next ? `<a class="pager next" href="${site(next.slug)}"><span>next</span>${next.nav}</a>` : `<span></span>`,
  ].join("\n      ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · Friar docs</title>
<meta name="description" content="Friar docs: a step-by-step guide to opening, reading, and closing a position, plus how the contracts work and where your funds sit." />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32" />
<meta name="theme-color" content="#100c07" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${title} · Friar docs" />
<meta property="og:image" content="https://friar.fi/og.png?v=3" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap" />
<link rel="stylesheet" href="/docs/docs.css" />
</head>
<body>
<header class="topbar">
  <a class="brand" href="/">FRIAR</a>
  <nav class="top-links">
    <a href="/docs/">docs</a>
    <a href="https://discord.gg/wCjfVcq9C" target="_blank" rel="noreferrer">discord</a>
    <a class="cta" href="https://app.friar.fi?ref=docs">launch app →</a>
  </nav>
</header>
<div class="shell">
  <aside class="side">
    <div class="side-h">the docs</div>
    <nav class="side-nav">
        ${nav}
    </nav>
  </aside>
  <main class="doc">
    ${body}
    <div class="pagers">
      ${pager}
    </div>
    <footer>
      friar.fi · an independent project on Robinhood Chain, not affiliated with or endorsed
      by Robinhood · nothing here is financial advice
    </footer>
  </main>
</div>
<script src="/beacon.js" defer></script>
</body>
</html>
`;
}

const CSS = `/* Friar's Robe — the same tokens as apps/web/src/app.css. Both themes at token level:
   prefers-color-scheme sets the default, and nothing here hardcodes a colour outside :root. */
:root {
  --bg: #100c07; --panel: #181209; --panel-inner: #211910; --border: #2a2012;
  --border-hover: #463620; --text: #ece3d2; --dim: #8a7a5f; --faint: #5d5138;
  --accent: #cf9440; --accent-hover: #ddaa5c; --on-accent: #171006;
  --green: #8fbf5f; --red: #e05d52; --gold-bg: rgba(207,148,64,.1);
  /* diagrams ship with their own dark palette, so their frame stays dark in both themes */
  --figure-bg: #100c07; --figure-border: #2a2012;
  color-scheme: dark;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f6efe0; --panel: #efe6d0; --panel-inner: #e8dcc2; --border: #dccfae;
    --border-hover: #c9b98f; --text: #2a2012; --dim: #78683f; --faint: #a09266;
    --accent: #8f6317; --accent-hover: #7a5313; --on-accent: #f6efe0;
    --green: #3e6b1d; --red: #a83a30; --gold-bg: rgba(143,99,23,.09);
    color-scheme: light;
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0; background: var(--bg); color: var(--text); line-height: 1.68;
  font-family: "IBM Plex Sans", system-ui, -apple-system, sans-serif;
  -webkit-font-smoothing: antialiased;
}
code, pre, .mono { font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace; }
a { color: var(--accent); text-decoration: none; }
a:hover { color: var(--accent-hover); }
a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }

/* top bar, matching the landing page */
.topbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 18px 28px; border-bottom: 1px solid var(--border);
}
.brand {
  font-family: "IBM Plex Mono", monospace; font-weight: 600; letter-spacing: .18em;
  color: var(--accent); font-size: 15px;
}
.top-links { display: flex; gap: 20px; align-items: center; font-size: 13px; }
.top-links a { color: var(--dim); font-family: "IBM Plex Mono", monospace; }
.top-links a:hover { color: var(--text); }
.top-links .cta {
  color: var(--on-accent); background: var(--accent); border-radius: 6px;
  padding: 8px 14px; font-family: "IBM Plex Sans", sans-serif; font-weight: 600;
}

/* Two-column shell. Wide on purpose: the diagrams are the point of these pages, and a
   46rem measure squeezed a 1600px drawing down to unreadable. */
.shell { display: grid; grid-template-columns: 16rem minmax(0, 1fr); gap: 4rem; max-width: 100rem; margin: 0 auto; padding: 2.5rem 2rem 5rem; }
@media (max-width: 1100px) { .shell { gap: 2.5rem; padding: 2rem 1.25rem 4rem; } }
@media (max-width: 900px) { .shell { grid-template-columns: 1fr; gap: 1.5rem; } }
.side { position: sticky; top: 2rem; align-self: start; display: flex; flex-direction: column; gap: .5rem; }
@media (max-width: 900px) { .side { position: static; } }
.side-h {
  font-family: "IBM Plex Mono", monospace; font-size: .68rem; letter-spacing: .16em;
  text-transform: uppercase; color: var(--dim); margin-bottom: .3rem;
}
.side-nav { display: flex; flex-direction: column; }
/* section label. Sits flush with the nav items' text so the 2px rail reads as one
   continuous line down the whole sidebar rather than restarting per group. */
.side-sec {
  font-family: "IBM Plex Mono", monospace; font-size: .64rem; letter-spacing: .16em;
  text-transform: uppercase; color: var(--faint); margin: 1.1rem 0 .25rem;
  padding-left: .7rem; border-left: 2px solid var(--border);
}
.side-nav > .side-sec:first-child { margin-top: .5rem; }
.nav-item {
  color: var(--dim); font-size: .95rem; padding: .35rem 0 .35rem .7rem;
  border-left: 2px solid var(--border);
}
.nav-item:hover { color: var(--text); border-left-color: var(--border-hover); }
.nav-item.active { color: var(--text); border-left-color: var(--accent); font-weight: 500; }

/* The page. The COLUMN is wide so figures and tables can use it; running text is capped
   separately at a comfortable measure, which is the only thing that wants to stay narrow. */
.doc { min-width: 0; max-width: 76rem; }
.doc p, .doc li, .doc h1, .doc h2, .doc h3, .doc blockquote, .doc pre { max-width: 48rem; }
.doc ul, .doc ol { max-width: 48rem; }
.doc h1 { font-size: clamp(1.9rem, 4.5vw, 2.5rem); font-weight: 600; letter-spacing: -.02em; line-height: 1.12; margin: 0 0 .8rem; text-wrap: balance; }
.doc h2 { font-size: 1.35rem; font-weight: 600; margin: 3rem 0 .6rem; letter-spacing: -.01em; }
.doc h3 { font-size: 1.08rem; font-weight: 600; margin: 2rem 0 .4rem; }
.doc p, .doc li { font-size: 1.02rem; }
.doc p { margin: 0 0 1.1rem; }
.doc ul, .doc ol { padding-left: 1.3rem; margin: 0 0 1.1rem; }
.doc li { margin-bottom: .5rem; }
.doc strong { color: var(--text); font-weight: 600; }
.doc hr { border: none; border-top: 1px solid var(--border); margin: 2.5rem 0; }
.doc code { font-size: .88em; background: var(--panel-inner); border: 1px solid var(--border); border-radius: 3px; padding: .08em .36em; overflow-wrap: anywhere; }
.doc pre { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 1rem 1.1rem; overflow-x: auto; }
.doc pre code { background: none; border: none; padding: 0; font-size: .86rem; line-height: 1.6; }
.doc blockquote {
  margin: 1.4rem 0; padding: .8rem 1.1rem; background: var(--panel);
  border-left: 2px solid var(--accent); border-radius: 0 6px 6px 0; color: var(--dim);
}
.doc blockquote p:last-child { margin: 0; }
.doc blockquote strong { color: var(--text); }

/* tables */
.doc .tbl { overflow-x: auto; margin: 1.4rem 0; }
.doc table { border-collapse: collapse; width: 100%; font-size: .95rem; min-width: 30rem; }
.doc th {
  font-family: "IBM Plex Mono", monospace; font-weight: 500; font-size: .66rem;
  letter-spacing: .12em; text-transform: uppercase; color: var(--dim); text-align: left;
  padding: .5rem .9rem .5rem 0; border-bottom: 1px solid var(--border);
}
.doc td { padding: .6rem .9rem .6rem 0; border-bottom: 1px solid var(--border); vertical-align: top; }
.doc tbody tr:hover td { background: var(--gold-bg); }

/* Figures: full column width, own dark ground in both themes (the diagrams ship with their
   own palette), and clickable to open the source at full size. */
.doc figure { margin: 2.2rem 0; width: 100%; }
.doc figure .frame {
  background: var(--figure-bg); border: 1px solid var(--figure-border); border-radius: 8px;
  padding: 1rem; overflow-x: auto; position: relative;
}
.doc figure .frame:hover { border-color: var(--border-hover); }
.doc figure a.zoom { display: block; cursor: zoom-in; }
.doc figure img, .doc figure svg.diagram { display: block; width: 100%; height: auto; }
/* the hint sits on the frame so it reads as "this whole thing opens" */
.doc figure .frame::after {
  content: "open full size ↗"; position: absolute; right: .9rem; bottom: .7rem;
  font-family: "IBM Plex Mono", monospace; font-size: .66rem; letter-spacing: .1em;
  color: var(--faint); opacity: 0; transition: opacity .15s;
}
.doc figure .frame:hover::after { opacity: 1; }
.doc figcaption { font-size: .9rem; color: var(--dim); margin-top: .7rem; max-width: 48rem; }
/* SCREENSHOTS (class="frame shot"). Unlike the diagrams, a UI capture already carries the
   app's own dark ground edge to edge, so padding it would draw a second, slightly-different
   dark band around it. Zero padding and let the capture's own edge be the frame. Capped
   narrower than a diagram too: these are ~1500px wide crops of a 1280px app column, and at
   full 76rem they render bigger than the app actually looks. */
.doc figure .frame.shot { padding: 0; max-width: 60rem; }
.doc figure .frame.shot img { border-radius: 7px; }
/* portrait captures (the whole open form, a modal) — at 60rem these render taller than a
   screen. Cap the WIDTH so the height follows the aspect ratio down to something readable. */
.doc figure .frame.shot.narrow { max-width: 26rem; }
@media (prefers-reduced-motion: reduce) { .doc figure .frame::after { transition: none; } }

/* callouts, written as > **note** … in markdown */
.doc .callout { border-left-color: var(--accent); }
.doc .callout.warn { border-left-color: var(--red); }

.pagers { display: flex; justify-content: space-between; gap: 1rem; margin-top: 4rem; padding-top: 1.4rem; border-top: 1px solid var(--border); }
.pager { display: flex; flex-direction: column; font-size: .98rem; color: var(--text); }
.pager span { font-family: "IBM Plex Mono", monospace; font-size: .68rem; letter-spacing: .14em; text-transform: uppercase; color: var(--dim); }
.pager.next { text-align: right; }
.doc footer { margin-top: 3rem; padding-top: 1.2rem; border-top: 1px solid var(--border); font-family: "IBM Plex Mono", monospace; font-size: .72rem; color: var(--faint); }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
`;

// ---- render -----------------------------------------------------------------------------
// marked's renderer signatures change between majors (v18 hands the method a token object,
// older versions handed it (text, level)), and a silently wrong override produces
// `<hundefined>` tags that browsers drop — which is exactly how the first build shipped with
// no headings at all. Post-processing the HTML instead is version-proof: it only depends on
// marked emitting ordinary <h2>/<table>, which every version does.
marked.use({ gfm: true });

/** Pixel dimensions of a PNG or GIF under public/, straight out of the header — PNG keeps
 * them in the IHDR chunk at a fixed offset, GIF in the logical screen descriptor. Both are a
 * handful of bytes, which is why this doesn't need an image library. Returns null for anything
 * else (or an unreadable file), and the caller just omits the attributes. */
function imageSize(src) {
  try {
    const buf = readFileSync(join(OUT, src.replace(/^\/docs\//, "")));
    if (buf.subarray(1, 4).toString("latin1") === "PNG")
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (buf.subarray(0, 3).toString("latin1") === "GIF")
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  } catch {
    /* missing file is already reported by the caller */
  }
  return null;
}

/** Wide tables get their own scroll container so the page body never scrolls sideways,
 * headings get ids so a doc can be linked to mid-page, and every figure image becomes a link
 * to its own source. Diagrams are 1600px wide and dense; at any column width they need a way
 * to be opened full size, and an SVG opened on its own scales to the whole window for free.
 * That beats a lightbox: no JS, works on mobile, and the URL is shareable. */
function enhance(html) {
  return html
    .replace(/<table>/g, '<div class="tbl"><table>')
    .replace(/<\/table>/g, "</table></div>")
    .replace(/<img src="([^"]+)"([^>]*)\/>/g, (_m, src, rest) => {
      const alt = (/alt="([^"]*)"/.exec(rest) ?? [, ""])[1];
      // SVG: INLINE it. An <img src="x.svg"> renders in an isolated document that cannot see
      // this page's fonts, so the diagram's "IBM Plex Mono" silently became whatever the
      // browser defaults to and looked nothing like the resvg-rendered PNG. Inlined, it
      // inherits the real webfonts this page already loads at the same weights. "Full size"
      // links to the PNG rather than the SVG for the same reason: opened standalone, an SVG
      // loses the fonts again.
      if (src.endsWith(".svg")) {
        const file = join(OUT, src.replace(/^\/docs\//, ""));
        let svg;
        try {
          svg = readFileSync(file, "utf8");
        } catch {
          console.error(`  missing diagram: ${src}`);
          return "";
        }
        svg = svg
          .replace(/<svg([^>]*?)\s+width="[^"]*"\s+height="[^"]*"/, "<svg$1")
          .replace(/<svg /, `<svg class="diagram" role="img" aria-label="${alt.replace(/"/g, "&quot;")}" `);
        const png = src.replace(/\.svg$/, ".png");
        return `<a class="zoom" href="${png}" target="_blank" rel="noreferrer" title="open full size">${svg}</a>`;
      }
      // Raster (the UI screenshots). Emit the real pixel dimensions so the browser reserves
      // the right box before the bytes arrive — no reflow as the page fills in.
      //
      // These were briefly `loading="lazy"` and it shipped a docs site with NO IMAGES: with
      // `height: auto` and no intrinsic size every figure lays out at zero height, so nothing
      // is ever far enough down the page for Chrome to decide it should now load, and the
      // requests are simply never made. Intrinsic dimensions are what makes lazy safe; the
      // pages carry at most seven shots, so plain eager loading is fine and this stays honest.
      const dim = imageSize(src);
      const size = dim ? ` width="${dim.w}" height="${dim.h}"` : "";
      return `<a class="zoom" href="${src}" target="_blank" rel="noreferrer" title="open full size"><img src="${src}" decoding="async"${size}${rest}/></a>`;
    })
    .replace(/<h([23])>(.*?)<\/h\1>/gs, (_m, level, inner) => {
      const id = inner
        .replace(/<[^>]+>/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      return `<h${level} id="${id}">${inner}</h${level}>`;
    });
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "docs.css"), CSS);

let built = 0;
for (const page of PAGES) {
  const file = join(SRC, `${page.slug}.md`);
  let md;
  try {
    md = readFileSync(file, "utf8");
  } catch {
    console.error(`  skipped ${page.slug}: no docs/${page.slug}.md yet`);
    continue;
  }
  const body = enhance(marked.parse(md));
  writeFileSync(join(OUT, `${page.slug}.html`), layout({ title: page.title, body, slug: page.slug }));
  built++;
}

const imgs = readdirSync(join(OUT, "img")).filter((f) => !f.startsWith("."));
console.log(`built ${built}/${PAGES.length} docs pages → apps/site/public/docs/ (${imgs.length} diagrams)`);
console.log(`urls: ${PAGES.map((p) => site(p.slug)).join("  ")}`);
