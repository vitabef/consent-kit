# Consent kit — HTML adapter

The kit for any website: a generator that writes the fragments a site pastes into its pages, from one site config.
No build tool, no framework, no npm package — only Node.js and a clone of this repository. Every fragment comes from
the kit's own sources and its committed build (`dist/`), so it is the reference markup and the shipped bytes. What
the kit does, every attribute, the cookie, the event and the record: [kit/README.md](../../kit/README.md).

## Requirements

- Node.js `^22.13.0 || >=23.4.0` (`engines` in `package.json`). Nothing to install: the generator needs no package
  (no `npm ci`).
- A clone of this repository at a release tag: `git clone --branch vX.Y.Z <repository URL>`. The tag is the kit's
  version; the fragments of one run belong together.

## Run

```sh
node adapters/html/generate.mjs site.json fragments/
```

It checks `site.json`, writes these files below `fragments/` (folders included) and lists them:

| File | Goes | What |
|---|---|---|
| `consent-mode.html` | first in `<head>` | the Google Consent Mode defaults: everything denied, no `url_passthrough` (the kit sets it, with marketing consent only) |
| `head.html` | right after them | the config block, the inline head snippet, the inline styles |
| `<lang>/banner.html` | first in `<body>`, before the skip link | the first layer and the settings dialog, in that language |
| `<lang>/footer-link.html` | in the footer of every page | the reopen link |
| `script.html` | right before `</body>`, after the gated tags | `kit.js`, deferred, with Subresource Integrity |
| `consent-kit/kit.<sha256>.js` | uploaded to the site's `/consent-kit/` | `dist/kit.js`, named by its SHA-256 — a new kit is a new name, so no cache serves an old one |

A page then looks like this (the order and why: [kit/README.md, Page structure](../../kit/README.md#page-structure)):

```html
<head>
  …
  <!-- consent-mode.html -->
  <!-- head.html -->
  …
</head>
<body>
  <!-- de/banner.html -->
  …
  <footer>… <!-- de/footer-link.html --> …</footer>
  <script type="text/plain" data-consent="analytics" src="…" async></script>
  <!-- script.html -->
</body>
```

Paste the fragments as they are: every value in them is escaped (the config block's JSON with each `<` as `\u003c`,
so no value can close it; the markup HTML-escaped), and the head snippet and the styles are the shipped bytes. A
gated tag is a `<script type="text/plain" data-consent="…">` ([Script gating](../../kit/README.md#script-gating)).

## The site config

One JSON file for the whole site; per-language values under `languages`. The example:
[`example/site.json`](example/site.json).

| Key | Required | Example | Meaning |
|---|---|---|---|
| `revision` | yes — an integer from 1 to 1,000,000 | `1` | the banner revision: raising it asks every visitor again (purge every cached page: [The stored choice](../../kit/README.md#the-stored-choice)) |
| `cookie` | yes — letters, digits, `_`, `.`, `-` | `"ck_consent"` | the name of the choice cookie |
| `domain` | no — a lower-case domain, no scheme, port or leading dot | `"example.com"` | the registrable domain: every cookie deletion is written once more with `Domain=<domain>` |
| `categories` | no | `{ "analytics": "stats" }` | kit category (`analytics`, `marketing`) → the `data-consent` value it activates; a category left out keeps its own name |
| `cleanup` | no | `{ "analytics": { "cookies": ["_ga", "_ga_*"] } }` | per category, what is deleted while it is not granted: `cookies` (exact names, or prefixes ending in `*`) and `localStorage` keys |
| `legacy` | no | `["previous-tool-consent"]` | a previous consent tool's cookies, deleted on every page load |
| `endpoint` | yes — an `https://` URL with a path, or `""` | `"https://consent.example.com/v1/record"` | where the records go; `""` = no records |
| `site` | with an endpoint — letters, digits, `_`, `.`, `-` | `"example-site"` | the site id in every record: one of the records service's `SITES` |
| `languages` | yes — one entry or more: `de`, `en` | see below | per language: `privacyUrl`, `imprintUrl` and, optionally, `texts` |

`languages.<lang>`:

| Key | Required | Meaning |
|---|---|---|
| `privacyUrl`, `imprintUrl` | yes — an `https://` URL, a path that starts with one `/`, or a `#fragment` | the privacy policy and the imprint, linked in both layers; the reopen link goes to `privacyUrl` |
| `texts` | no | the site's own texts, under the keys of `kit/src/i18n/<lang>.json` (`_note` excepted) — each a non-empty string |

`revision`, `cookie`, `domain`, `categories`, `cleanup` and `legacy` make the config block
([The config block](../../kit/README.md#the-config-block)); `categories` is always written whole, as kit.js
activates nothing for a category the config does not name. `endpoint` and `site` become the first layer's
`data-endpoint` and `data-site`. Two more rules: the two categories activate different `data-consent` values (one
value for both would let either grant activate both categories' tags), and no `cleanup` pattern or `legacy` name
matches the choice cookie itself (kit.js would delete the visitor's choice). A key the table does not name, a value
of the wrong type or form, a language without the kit's strings, a file that cannot be read or is not JSON: the
generator stops with a message that starts with `consent-kit:` and the file's name, and writes nothing.

## What to change

- **The texts.** The strings in `kit/src/i18n/*.json` are samples for a site with an analytics and an advertising
  service, not legal advice: put the site's own legally reviewed texts into `languages.<lang>.texts`
  ([i18n](../../kit/README.md#i18n)). A line break in `text` starts a new block of the first layer's paragraph
  ([The first-layer text in blocks](../../kit/README.md#the-first-layer-text-in-blocks)). The reopen link's text is
  `dialogTitle`, the name the first-layer text sends visitors to at the bottom of the page: keep the two in step.
- **The Consent Mode defaults.** `consent-mode.html` is the kit demo's. A site that sets its own (in a tag manager,
  for example) leaves it out and keeps its own first in `<head>`, before `head.html`: everything denied, no
  `url_passthrough`.
- **The colours.** The kit's `--ck-cc-*` tokens, overridden in the site's own CSS after `head.html`
  ([Theming](../../kit/README.md#theming)).
- **Where kit.js lives.** `script.html` loads it from `/consent-kit/` with an `integrity` attribute. Another path
  works on the site's own origin only — the tag has no `crossorigin`, so a browser blocks a file from another origin
  under `integrity` — and only with the file served byte for byte: a CDN or server step that minifies or rewrites it
  fails the integrity check. Either way kit.js never runs, and the page has no working consent layer (the head
  snippet hides the first layer at `load`; no gated tag is activated and no new choice can be made).
- **A Content Security Policy.** Allow the endpoint in `connect-src` ([The record](../../kit/README.md#the-record)).
  The three inline elements — the defaults, the head snippet, the styles — are fixed bytes: allow each by the
  `'sha256-…'` hash of its exact text (or with a nonce from the server); `kit.js` is same-origin (`'self'`). The
  config block is data, not script: no CSP rule is needed for it.

## After a kit update

1. Move the clone to the new release tag.
2. Run the generator again with the same `site.json`.
3. Replace every fragment in the site's pages. The head snippet and kit.js ship as a pair
   ([Page structure](../../kit/README.md#page-structure)): never a new `head.html` with an old `script.html`, or the
   other way round.
4. Upload the new `consent-kit/kit.<sha256>.js`. Keep the older ones while cached pages may still ask for them.
5. Purge the cached HTML — after a `revision` change, every page of the site.

## Example and tests

[`example/fragments/`](example/fragments/) is the generator's output for [`example/site.json`](example/site.json).
`npm run build` in this repository regenerates it, replacing the whole folder; never edit it by hand.
`adapters/html/test/html.test.ts`, part of `npm test` and the gate, checks:

- the example is one fresh generation and nothing else;
- the fragments: the demo's Consent Mode defaults, the config block of `kit/build.mjs` with every category mapped, the
  head snippet and the styles byte for byte as built, the reference markup per language with the sample strings or
  the site's own (the first-layer text in blocks), the reopen link, kit.js named by its SHA-256 with a matching
  integrity;
- a value that tries to close the config block or leave an attribute, the optional keys left out, every check of the
  site config with its message, and the command line.
