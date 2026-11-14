# Consent kit — site integration guide

How a website embeds the kit. Everything below is what `kit/src/head.js`, `kit/src/kit.js`, `kit/src/kit.css` and
`kit/templates/banner.html` do; `kit/test/kit.test.ts` pins it on the minified bytes. The records service the kit
reports to is described in the [repository README](../README.md).

## Build output

`node kit/build.mjs` (`npm run build`) minifies the three shipped files with esbuild (JavaScript for ES2017, no legal
comments) and writes `kit/dist/` (git-ignored):

| File | What | Brotli budget |
|---|---|---|
| `head.js` | the head snippet — inlined by the site | 900 B |
| `kit.js` | the deferred logic file — vendored by the site | 2,500 B |
| `kit.css` | the styles — inlined by the site | 2,200 B |
| `sizes.json` | raw, gzip (level 9) and brotli (quality 11) bytes per file, with its budget | — |
| `demo/index.html`, `demo/en/index.html`, `demo/fake-analytics.js` | the [demo page](#demo), German and English | — |

The build exits with code 1 when a file is over its budget. The budgets are about 1.5 × the first build and stay inside
hard ceilings of 1 KB / 3 KB / 6 KB (the kit sits on every page of a site); `kit/test/build.test.ts` checks both. The
file names are fixed: the build adds no fingerprint — the site's pipeline fingerprints `kit.js` when it vendors it.

The build writes `head.js`, `kit.js` and `kit.css` once more, byte for byte, to `dist/` at the repository root. That
copy is committed: it is what a site vendors and what a site adapter mounts, and `kit/test/build.test.ts` fails while
it differs from a fresh build.

## Page structure

```html
<head>
  <!-- 1. the site's Google Consent Mode defaults: everything denied, no url_passthrough -->
  <script data-cfasync="false">…</script>
  <!-- 2. the kit's config -->
  <script type="application/json" id="ck-config">{"revision":1,"cookie":"ck_consent",…}</script>
  <!-- 3. kit/dist/head.js, inlined -->
  <script data-cfasync="false">…</script>
  <!-- 4. kit/dist/kit.css, inlined -->
  <style>…</style>
</head>
<body>
  <!-- 5. kit/templates/banner.html, rendered: the FIRST thing in <body>, before the skip link -->
  <div class="ck-cc" role="region" … data-ck-banner data-endpoint="…" data-site="…">…</div>
  <dialog class="ck-cd" … data-ck-dialog>…</dialog>
  <!-- … the page … -->
  <!-- 6. the reopen link, in the footer of every page -->
  <a href="…" data-ck-open>Cookie-Einstellungen</a>
  <!-- 7. gated tags -->
  <script type="text/plain" data-consent="analytics" src="…" async></script>
  <!-- 8. kit/dist/kit.js, last -->
  <script data-cfasync="false" src="/…/kit.<fingerprint>.js" defer></script>
</body>
```

Why this order:

- The head snippet reads the config block, so the block comes first. For a returning visitor the snippet pushes the
  Consent Mode update at once, so it comes after the defaults; kit.js activates the gated tags only later.
- The CSS is inline, so the first layer is styled at its first paint.
- The first layer is server-rendered first in `<body>`: painted with the page, never inserted later, the first stop for
  the keyboard.
- kit.js is deferred: it runs after the parse, when inline end-of-body scripts have registered their listeners. If it
  has not booted by `load` (blocked, 404, an old engine), the head snippet hides the first layer — nothing can be
  granted without kit.js; a later boot shows it again.

`head.js` and `kit.js` ship as a pair: kit.js calls the head snippet's internals (`consentKit._u`, `consentKit._r`), so
a page always carries the two files of one build. Next to a head snippet without the reader (`_r`), kit.js still
decides, but reads nothing back and follows no other tab.

The demo's Consent Mode defaults (`kit/demo/index.html`), as an example:

```html
<script data-cfasync="false">
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  gtag("consent", "default", {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: "denied",
    functionality_storage: "denied",
    personalization_storage: "denied",
    security_storage: "granted",
    wait_for_update: 2000,
  });
  gtag("set", "ads_data_redaction", true);
</script>
```

`url_passthrough` is not part of the defaults: the kit sets it, and only with marketing consent.

### The config block

`<script type="application/json" id="ck-config">` holding JSON in which every `<` is escaped as `\u003c`, so
no string can close the element (`configBlock()` in `kit/build.mjs` does exactly that).

| Key | Required | Demo value | Meaning |
|---|---|---|---|
| `revision` | yes — an integer from 1 to 1,000,000 | `1` | the banner revision: a stored choice counts only for this value, so raising it asks everyone again. The range is the records service's; any other value counts as no config |
| `cookie` | yes — a non-empty string | `"ck_consent"` | the name of the choice cookie |
| `domain` | no | — | a registrable domain: every cookie deletion is written a second time with `Domain=<domain>` |
| `categories` | no | `{"analytics": "analytics", "marketing": "marketing"}` | kit category → the `data-consent` value it activates |
| `cleanup` | no | `{"analytics": {"cookies": ["_ga", "_ga_*"]}, "marketing": {"cookies": ["_gcl_*"], "localStorage": ["_gcl_ls"]}}` | what a category that is not granted deletes: cookie names (a trailing `*` = a prefix) and `localStorage` keys |
| `legacy` | no | `["previous-tool-consent"]` | a previous consent tool's cookies, deleted on every page load |

The demo values are `demoConfig()` in `kit/build.mjs`; the demo sets no `domain`. For a site on `www.example.com`, set
`domain` to `example.com`: the tracking cookies are then deleted on the host and on `.example.com`, since a tag may
have written them on either.

No block, invalid JSON, a `revision` that is not an integer from 1 to 1,000,000, or a missing or empty `cookie` means no
config: the visitor stays undecided, kit.js does nothing (nothing is granted, written or sent) and the first layer is
hidden at `load`.

### The markup

`kit/templates/banner.html` holds the first layer (`<div class="ck-cc" role="region">`) and the settings
`<dialog class="ck-cd">`. Render it on the server in the page language and keep every `data-ck-*` attribute,
id and class unchanged; its ids allow one kit per page. The leading comment is developer documentation (the reference
renderer drops it). Placeholders are `{{key}}`, and every value is HTML-escaped:

| Placeholder | Value |
|---|---|
| `{{title}}`, `{{text}}`, `{{privacy}}`, `{{imprint}}`, `{{acceptAll}}`, `{{rejectAll}}`, `{{settings}}`, `{{dialogTitle}}`, `{{close}}`, `{{analytics}}`, `{{analyticsDetails}}`, `{{marketing}}`, `{{marketingDetails}}`, `{{saveChoice}}` | the string of that key in `kit/src/i18n/<lang>.json` ([i18n](#i18n)) |
| `{{privacyUrl}}`, `{{imprintUrl}}` | the site's privacy policy and imprint URLs (linked in both layers) |
| `{{endpoint}}` | the records endpoint, e.g. `https://consent.example.com/v1/record`; empty = no records |
| `{{site}}` | the site id — one of the records service's `SITES` |

The reference renderer (`renderBanner()` in `kit/build.mjs`) treats a placeholder without a value as an error, never as
an empty string.

### Attributes

The kit uses one click listener on `document`, so the attributes below work on any element, also on elements added
after the kit has booted.

| Attribute | On | Meaning |
|---|---|---|
| `id="ck-config"` | `<script type="application/json">` | the config block, read by the head snippet |
| `data-ck-banner` | the first layer | hidden by the CSS once the visitor has decided |
| `data-endpoint` | the first layer | where the records go — empty, or no first layer: no record |
| `data-site` | the first layer | the site id in every record — empty: no record |
| `data-ck-dialog` | the `<dialog>` | the settings layer, opened with `showModal()` |
| `data-ck-action` | a button | `accept`, `reject` or `save` (save reads the two switches); other values are ignored |
| `data-ck-open` | any element | opens the settings dialog ([reopen link](#reopen-link)) |
| `data-ck-close` | the dialog's close button | closes the dialog without a decision |
| `data-ck-category` | the two switches | `analytics` or `marketing` |
| `data-consent` | `script[type="text/plain"]` | the value that activates the tag ([script gating](#script-gating)) |
| `data-consent-state` | a gated tag | set to `active` by the kit once the tag is activated |
| `lang` | `<html>` | its primary subtag, lower-cased (`de-DE` → `de`), is sent as the record's `lang` |
| `data-bs-theme` | `<html>` | `dark` / `light`, read by the CSS ([theming](#theming)) |

`data-nosnippet` on both layers is for search engines (the kit does not read it); `closedby="any"` on the dialog lets a
click on the backdrop close it.

## `window.consentKit`

Defined synchronously by the head snippet, so inline scripts after it can read it.

```js
consentKit.get();  // → { analytics: boolean, marketing: boolean, decided: boolean, revision: number | null }
consentKit.open(); // opens the settings dialog
```

- `get()` — the current state. `revision` is `null` without a valid config. A GPC visitor reads `decided: true` with
  both categories `false`.
- `open()` — called before kit.js has booted, it only queues the call; kit.js replaces `open` when it boots and then
  opens the dialog. After that it opens the dialog at once; it does nothing while the dialog is open, without the dialog
  markup, or where `showModal()` is missing.
- `_c`, `_s`, `_q`, `_k`, `_u`, `_r` are kit-internal (the parsed config, the state, the queued `open()`, kit.js ready,
  the Consent Mode update, the reader of the stored choice).

## The `consentkit:change` event

`document.dispatchEvent(new CustomEvent("consentkit:change", { detail: consentKit.get() }))` — `detail` has the shape of
`get()`. It fires:

- once when kit.js boots, if the visitor has decided (a valid stored choice, or GPC);
- once per decision — after the Consent Mode update and the activation of gated tags, before the record;
- once when a page that stays alive follows a decision made in another tab ([a page that stays
  alive](#a-page-that-stays-alive));
- not for an undecided visitor at boot, and not for a withdrawal (the page reloads instead).

**Consumer rule:** read `consentKit.get()` first, then listen to `consentkit:change`. An inline listener at the end of
`<body>` is registered before the deferred kit.js runs; a listener from a later `defer`, `async` or module script has
missed the event at boot.

## Script gating

```html
<script type="text/plain" data-consent="analytics" src="/js/analytics.js" integrity="…" crossorigin="anonymous" async></script>
<script type="text/plain" data-consent="analytics">/* an inline tag works too */</script>
```

When a category is granted — at boot for a decided visitor, after every decision except a withdrawal, and when a page
that stays alive follows a grant made in another tab — the kit takes every `script[type="text/plain"][data-consent]`
whose value `categories` maps to that category and inserts a real `<script>` right after it:

- every attribute travels except `type`, `id` and `data-consent-state` (`src`, `integrity`, `crossorigin`, `nonce`,
  `referrerpolicy`, `fetchpriority`, `data-*` …); the `nonce` property is copied too;
- `data-cfasync="false"` is set; an inline tag's text is copied;
- the copy is `async` only when the original has `async`.

The original gets `data-consent-state="active"` and is never inserted again. A running tag cannot be unloaded — that is
why a withdrawal reloads the page.

## The stored choice

| | |
|---|---|
| Name | `cookie` from the config (`ck_consent`) |
| Value | `encodeURIComponent(JSON.stringify({v, a, m, t}))` — `v` the revision, `a` analytics and `m` marketing as 0 or 1, `t` the time in unix seconds; no visitor id |
| Attributes | `Max-Age=15552000` (180 days), `Path=/`, `SameSite=Lax`, and `Secure` on https only (a plain-http test host would drop the whole cookie); no `Domain`, so the cookie belongs to the host |
| Written | only on a decision — the automatic GPC reject writes none; every existing copy (on the host, with `domain` on the domain, and on the full hostname) is deleted first |
| Read | by the head snippet: a copy counts only when `v` equals `revision`, `a` and `m` are 0 or 1 and `t` is a positive integer; with several valid copies the most restrictive one counts; anything else = undecided |
| Asking again | raise `revision`: every stored choice stops counting and the first layer shows again |

A revision bump needs every cached copy of the site's HTML purged: a page still on the old revision counts the new
choice as none and a decision there replaces it, so tabs on the old and the new revision invalidate each other's choice.

Known limit: Safari caps cookies written by script at 7 days, so a Safari visitor may be asked again sooner.

## Google Consent Mode

The kit pushes these gtag commands onto `window.dataLayer` (created when missing):

```js
gtag("consent", "update", { analytics_storage: a, ad_storage: m, ad_user_data: m, ad_personalization: m }); // "granted" | "denied"
gtag("set", "url_passthrough", true); // only with marketing granted
```

- A returning visitor with a valid choice: from the head snippet, at once — before kit.js can activate any tag.
- Every decision: synchronously in the click, before the activation.
- A page that follows a decision made in another tab: before its activation.
- GPC and undecided visitors: nothing — the site's defaults stay denied.

There is one implementation, the head snippet's (`consentKit._u`), which kit.js calls. Only these four types change;
the other defaults (`functionality_storage`, `personalization_storage`, `security_storage`) stay as the site set them.

## Global Privacy Control

`navigator.globalPrivacyControl === true` without a valid stored choice counts as a reject: decided, both categories
off, the first layer hidden; no cookie, no record, no Consent Mode update (the defaults are already denied); the cleanup
runs; `consentkit:change` fires once at boot. A valid stored choice wins over GPC. The reopen link still opens the settings
dialog, so an explicit opt-in stays possible — it is stored and recorded like any choice.

## Cleanup and withdrawal

- **Every page load** (kit.js boot): the `legacy` cookies are deleted, then the cleanup runs for every category that is
  not granted — undecided, GPC and denied visitors alike.
- **Every decision**: the cleanup runs for each denied category.
- **The cleanup** deletes the category's `cookies` (exact names, or prefixes ending in `*`) in the three scopes below, and
  removes its `localStorage` keys. With the demo config: `_ga` and `_ga_*` for analytics; `_gcl_*` and the
  `localStorage` key `_gcl_ls` for marketing.
- **A withdrawal** — a decision (a reject, or a saved choice) that denies a category granted before — runs: the cookie,
  the Consent Mode update, the cleanup, the record with `action: "withdraw"`, then `location.reload()`. No activation,
  event or focus work comes first, and every further deciding click on that page is ignored while the reload is under
  way: for 10 seconds, or until the page comes back from the back/forward cache — a host's `beforeunload` prompt can
  cancel the reload, and the page must not stay dead.
- **A previous consent tool**: `legacy: ["previous-tool-consent"]` deletes a previous consent tool's cookie in the
  three scopes below, on every load.
- **Three scopes**: each cookie deletion (`Path=/`) covers the host-only cookie, the configured `domain`
  (`Domain=<domain>`) and the full hostname (`Domain=<hostname>`, e.g. `.www.example.com`, which a previous tool or a
  tag may have set and neither of the other two removes); on a page served on `domain` itself those two are one. Not
  covered: a copy with another `Path`, and one on an intermediate parent domain (page `a.b.example.com`, `domain`
  `example.com`, a cookie on `.b.example.com`).

## A page that stays alive

A page restored from the back/forward cache (`pageshow` with `persisted`) or a tab coming back into view
(`visibilitychange` to `visible`) reads the stored choice again with the head snippet's own reader (GPC included) and
compares it with its state:

- a category this page granted is now denied, or there is no valid choice any more → `location.reload()` (a loaded tag
  cannot be unloaded); deciding clicks then wait for the reload as after a withdrawal;
- the page has become decided or gained a grant (a decision in another tab) → it follows that decision: the state,
  `ck-decided` on `<html>`, the Consent Mode update (none under GPC), the activation and `consentkit:change` — but
  no cookie write and no record (the deciding page did both); an open settings dialog's switches show the new state,
  and focus inside the now hidden first layer moves to `<main>`, as after a decision there;
- unchanged → nothing.

A restore from the back/forward cache fires both events, in either order. It lifts only a reload guard that was up when
the page was hidden (`pagehide`) — that reload never ran — never the guard of a reload the first of the two events
started, so the page reloads once.

Cookies blocked: right after a decision the kit reads the stored choice back. When the cookie did not stick, that page
skips the reload for a lost choice while no choice is stored — it stays as decided instead of asking again (the
decision is recorded as usual); the first stored choice it reads (a decision in another tab) ends that, so losing that
choice later reloads as usual. The next page load asks again — under GPC it is a silent reject, not a question.

## Reopen link

Any element with `data-ck-open` opens the settings dialog. The first-layer text points visitors to
„Cookie-Einstellungen“ / “Cookie settings” at the bottom of the page, so every page needs that footer link; its text is
the site's, not one of the kit's strings. Give it a real `href`: the kit prevents the navigation only where the settings
dialog exists — without the dialog markup, or in an engine without `showModal()`, the link is followed.
`consentKit.open()` does the same from a script.

## The record

After every decision — after the event; for a withdrawal right before the reload — the kit sends one request:

```js
fetch(endpoint, {
  method: "POST",
  body: JSON.stringify({ site, v, a, m, action, lang }),
  keepalive: true,
  credentials: "omit",
  mode: "no-cors",
});
```

- `endpoint` and `site` come from the first layer's `data-endpoint` and `data-site` — the markup, not the config. Either
  empty, or no first layer: no record, and the decision still stands.
- `v` = `revision`; `a`, `m` = the new choice (0 or 1); `action` = `accept`, `reject`, `save` or `withdraw`;
  `lang` = the primary subtag of `<html lang>`, lower-cased (`de-DE` → `de`, `EN` → `en`; no or an empty `lang` sends
  `""`).
- A `text/plain` body, so no preflight; no cookies; the answer is never read and a failure is ignored. Never
  `sendBeacon` (it sends cookies).
- No request of any kind before a decision. This record is the only request the kit makes to another host — a site
  with a Content Security Policy must allow the endpoint in `connect-src` (for example
  `connect-src 'self' https://consent.example.com`), or the browser blocks the record; the decision still
  stands.
- The service stores the record only when `site` is in its `SITES` and `lang` is `de` or `en`, and drops it silently
  otherwise ([records service](../README.md#post-v1record)) — a page in another language, or without `lang`, still
  decides, but its records are not stored. `v` always lies in the service's range: the head snippet treats any other
  `revision` as no config.

## i18n

`kit/src/i18n/de.json` and `en.json` carry the same keys. They are samples for a site with an analytics and an
advertising service — not legal advice: every site supplies its own legally reviewed texts and renders them into the
same keys. The `_note` key (no placeholder) says so.

| Key | Used as |
|---|---|
| `title` | the first layer's `aria-label` (it has no visible title) |
| `text` | the first layer's one paragraph |
| `privacy`, `imprint` | the link texts (both layers) |
| `acceptAll`, `rejectAll` | the decision buttons (both layers) |
| `settings` | the first layer's button that opens the dialog |
| `dialogTitle` | the dialog's heading (`<h2>`) |
| `close` | the dialog's close button |
| `analytics`, `marketing` | the category names (`<summary>`) |
| `analyticsDetails`, `marketingDetails` | the category texts (inside `<details>`) |
| `saveChoice` | the dialog's save button |

## Theming

Colours are custom properties on `.ck-cc, .ck-cd`, with these defaults:

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--ck-cc-bg` | `#fff` | `#2b3035` | surfaces |
| `--ck-cc-fg` | `#212529` | `#dee2e6` | text |
| `--ck-cc-line` | `#dee2e6` | `#495057` | borders |
| `--ck-cc-accent` | `#1d4163` | `#7fa6cf` | buttons, links, switches, focus ring |
| `--ck-cc-wash` | `rgb(29 65 99 / 0.1)` | `rgb(127 166 207 / 0.14)` | hover and pressed buttons |
| `--ck-cc-off` | `#6c757d` | `#8f99a3` | a switch that is off |
| `--ck-cc-shade` | `rgb(33 37 41 / 0.16)` | `rgb(0 0 0 / 0.45)` | shadows |
| `--ck-cc-z` | `1025` (fallback, not set) | | the first layer's `z-index` |

- The dark values apply under an ancestor with `data-bs-theme="dark"`; without that attribute they follow
  `prefers-color-scheme: dark`, unless `<html>` has `data-bs-theme="light"`. `color-scheme` follows along.
- A site overrides the tokens after the kit's CSS, on `.ck-cc, .ck-cd`, with the same theme selectors.
- `font-family: inherit` — the host's font; no web font, no image.
- The first layer is `position: fixed` at the bottom — it never moves the page — with explicit line-heights. Phones: the
  text, then the three buttons in one row; from `36em`: the text left, the buttons stacked on the right; from `64em`:
  the buttons in one row on the right.
- It is hidden while `<html>` has `ck-decided` (decided), `ck-settings` (the dialog is open) or
  `ck-off` (kit.js had not booted by `load`), with scripting off, and in print.
- While it is shown, the page makes room for it: a scroll padding on `<html>` and `<body>` and a spacer at the end of
  `<body>`, all from its measured height ([accessibility](#accessibility), Focus not obscured).

## Accessibility

- **First layer**: a non-modal landmark — `role="region"` named by `aria-label` — that never blocks the page. No heading
  (the page outline starts with the host's `h1`). First in `<body>`, so it is the first keyboard stop.
- **Settings**: a native `<dialog>` opened with `showModal()` and named by its `<h2>` (`aria-labelledby`). Escape, the
  close button and a click on the backdrop close it without a decision (`closedby="any"`; where `closedBy` is
  unsupported, the kit treats a press and release outside the dialog as that click). Every opening shows the stored
  choice (both switches off while undecided). While it is open, `<html>` has `ck-settings` and the first layer
  is hidden, so only one set of buttons is on screen.
- **Switches**: `<input type="checkbox" role="switch">`, labelled by the category's `<summary>` and described by its
  text.
- **Focus**: when the dialog closes, focus returns to the element that opened it if that is still on screen, else to
  `<main>` (else `<body>`) with a temporary `tabindex="-1"`; after a decision in the first layer, or one followed from
  another tab while focus is in it, it goes to `<main>`. A late `close` event of an earlier opening (Chromium fires it a
  task after Escape) leaves a dialog opened again in the meantime alone.
- **Focus not obscured** (WCAG 2.4.11): the first layer covers the bottom of the viewport, so while it is shown (the
  visitor undecided, kit.js booted) every focused element must be able to scroll clear of it — the last ones on the
  page, the footer's links, included. kit.js keeps the layer's height in the custom property `--ck-layer-h` on
  `<html>`: a `ResizeObserver` follows every change (no layout is forced at boot); without one, it is measured at boot
  and again at every focus check (a rotation, a layout after boot). kit.css turns it into:
  - `scroll-padding-bottom` on `<html>` and on `<body>` (for a `<body>` that is a scroll container itself) — the
    height + `0.5rem` — so the browser scrolls a focused element above the layer; `30vh + 0.5rem` until the height is
    measured;
  - a spacer as high as that padding, so that the last element can scroll that far too: an empty
    `<div id="ck-sp" aria-hidden="true">` that kit.js appends as the last child of `<body>`. Its geometry is forced
    on the id with `!important` — `display: block`, the height, `flex: none`, no margin, padding or border,
    `visibility: hidden`, `pointer-events: none` — so a site's usual rules for the children of `<body>` (display,
    margins, flex shrinking) neither hide nor shrink it. As content of a `<body>` that stacks its children in a
    column — the common case — it adds room whatever the site does with its root boxes: `html, body { height: 100% }`
    (also as a flex column, the sticky-footer pattern), a flex `<html>`, a site's own `html::after` (left alone). A
    `<body>` that lays its children out in a row is a limit (below). Screen media only; without a measured height it
    has none.

  A keyboard focus (`:focus-visible`; in an engine without that selector, every focus) that the layer still covers
  once its position has held still for two frames (an engine that ignores the scroll padding for focus) is scrolled
  into view with `scrollIntoView({ block: "nearest" })`, `behavior: "smooth"` — or `"auto"` when the visitor prefers
  reduced motion. Waiting for a still position leaves the browser's own focus scroll alone, a smooth one too (a
  site's `scroll-behavior: smooth`): it is never restarted; an element that keeps moving is checked after 120 frames.
  Covered means overlapping the layer's box: an element below the viewport (a site's `focus({ preventScroll: true })`)
  is not, and stays where it is. Left alone too: a pointer focus (a click focuses what it shows), the layer's own
  controls, an element taller than the space above the layer that already shows, and focus that has moved on by
  then. While the dialog is open the layer is hidden and the property keeps its last value, so nothing behind the
  modal moves. A decision — or one followed from another tab — removes the property, the spacer, the observer and
  the focus check, and with them the padding (a page scrolled to its very end moves down by the spacer's height,
  right after the click). A decided visitor, GPC included, never gets either: no layout shift.

  Limits:
  - While the visitor is undecided, the scrollable area grows by the layer's height: a short page may become
    scrollable, and a footer that `min-height: 100vh` on a flex `<body>` holds at the bottom moves up by that height
    when kit.js boots — a layout shift.
  - An app shell — `overflow: hidden` on `<html>` and `<body>`, the content scrolling in a container inside — gets its
    room from `<body>`: a focus in the container's last layer height scrolls `<body>`, and the whole shell with it, up
    by up to that height; it comes back when the visitor decides.
  - A scroll container that does not move with `<body>` (`position: fixed`) gets no room: a focus in its last layer
    height stays under the layer.
  - A `<body>` that lays its children out in a row — `display: flex` in a row, a grid that flows into columns, a
    grid with template areas that leave a cell empty — gets no room: the spacer becomes an item beside the content
    (or in the empty cell), and a focus in the page's last layer height stays under the layer. With a `gap`,
    `justify-content: space-between` or a column-flow grid the spacer also takes its share of the row until the
    visitor decides: the main column is narrower or shifted, a grid gets one more column.
  - The forced geometry covers display, height, flex, margins, padding and border, not `min-height`, `max-height`,
    `position`, `float` or `order`: a site rule for the children of `<body>` that sets one of them (for example
    `body > div { min-height: 50vh }`) can make the spacer taller or move it.
  - The spacer is the last child of `<body>` when kit.js boots; whatever the site appends to `<body>` later comes
    after it, and a focus there can stay under the layer.
- **Equal weight**: the three decision buttons of a layer share one class (`.ck-cc-btn`) and one look; the close
  button is a quiet text button that decides nothing. Buttons are at least 44 px high, the close button 44 × 44 px, a
  switch's touch target 52 × 44 px; a 3 px focus ring; switch rules for forced colours and reduced motion.
- **No `<dialog>` support** (`showModal()` missing): no settings layer; reopen links follow their `href`; the first
  layer still decides.

## `data-cfasync="false"`

Every kit `<script>` carries it — the inline head snippet and the deferred kit.js — and the kit sets it on every tag it
activates, so Cloudflare Rocket Loader leaves them in place. The demo's Consent Mode defaults carry it too.

## Demo

`npm run build` renders `kit/demo/index.html` into `kit/dist/demo/index.html` (German) and
`kit/dist/demo/en/index.html` (English), emitting the kit exactly as a site adapter does: the config block, the inline
head snippet and CSS, the markup first in `<body>`, `/kit.js` deferred. Serve `kit/dist/` as the web root with any
static server. The page has a Light / Dark / Auto theme switch, a footer reopen link, one gated tag
(`demo/fake-analytics.js`, which only counts its runs) and a status line with `consentKit.get()`. Its `data-endpoint`
is empty, so it sends no records. It is for local development only, never deployed.

## Tests

`kit/test/kit.test.ts` runs the minified `head.js` and `kit.js`, exactly as built, in happy-dom on the rendered
reference markup; the network is impossible by construction (`fetch` is a spy, script loading and navigation are off).
`kit/test/build.test.ts` checks the budgets, the German and English strings and the rendering. Both run in `npm test`
and in the gate.
