# Consent kit — Hugo module

This repository is a Hugo module. A Hugo site imports it, pinned to a version, and renders the kit with three
partials. The module is a thin adapter: it ships the kit's committed build output (`dist/` at the repository root —
the same files any other site vendors), the kit's reference markup turned into a partial, and the sample strings as
Hugo translations. What the kit does, every attribute, the cookie, the event and the record: [kit/README.md](../../kit/README.md).

## Requirements

- Hugo 0.141.0 or later (the module's `hugoVersion`), tested with 0.141.0 and 0.169.0: the test suite runs on the
  extended builds of both. The module itself needs no feature of the extended edition.
- Go, which Hugo Modules use to download and pin a module (`hugo mod get`); this module's `go.mod` asks for Go 1.20
  or later. And a site that is a module itself (`hugo mod init <the site's module path>` writes its `go.mod`).

## Import and version

In the site's configuration:

```toml
[module]
  [[module.imports]]
    path = "github.com/vitabef/consent-kit"
```

A version is a git tag `vX.Y.Z` of this repository. Pin one, or move to another, with:

```sh
hugo mod get github.com/vitabef/consent-kit@vX.Y.Z
```

It writes the version into the site's `go.mod` and `go.sum`; commit both. Without `@vX.Y.Z`,
`hugo mod get github.com/vitabef/consent-kit` installs the newest version. The head snippet and kit.js always come
from the same version, so they ship as the pair they have to be (kit/README.md, Page structure).

## What reaches the site

The module's mounts (`hugo.toml` at the repository root) — nothing else of the repository:

| Source | Mounted at | What |
|---|---|---|
| `adapters/hugo/layouts` | `layouts` | the partials `consent-kit/head.html`, `consent-kit/banner.html`, `consent-kit/script.html` and the internal `consent-kit/params.html` |
| `adapters/hugo/i18n` | `i18n` | the sample strings, ids `consentKit_<key>`, German and English |
| `dist` | `assets/consent-kit` | `head.js`, `kit.js`, `kit.css` — the kit's minified build, committed |
| `adapters/hugo/package.hugo.json` | `assets/_jsconfig/package.hugo.json` | an empty npm manifest: the module needs no npm package, and without a mount of its own there Hugo would mount the repository's `package.json` (the records service's tooling) into the site |

## Placement

```go-html-template
<head>
  …
  {{/* 1. The site's Google Consent Mode defaults: everything denied, no url_passthrough. */}}
  <script data-cfasync="false">… gtag("consent", "default", { … }); …</script>
  {{/* 2. Right after them: the config block, the inline head snippet, the inline styles. */}}
  {{ partial "consent-kit/head.html" . }}
  …
</head>
<body>
  {{/* 3. The first thing in <body>, before the skip link: the first layer and the settings dialog. */}}
  {{ partial "consent-kit/banner.html" . }}
  …
  {{/* 4. In the footer of every page: the reopen link the first layer's text points to. */}}
  <a href="/datenschutz/" data-ck-open>{{ i18n "cookieSettings" }}</a>
  …
  {{/* 5. Gated tags: type="text/plain" with data-consent (kit/README.md, Script gating). */}}
  <script type="text/plain" data-consent="analytics" src="…" async></script>
  {{/* 6. Right before </body>: the deferred logic file. */}}
  {{ partial "consent-kit/script.html" . }}
</body>
```

| Partial | Emits |
|---|---|
| `consent-kit/head.html` | `<script type="application/json" id="ck-config" data-cfasync="false">` with the config from the parameters (JSON in which `<`, `>` and `&` are escaped, so no value can close the element); `<script data-cfasync="false">` with `dist/head.js` inline; `<style>` with `dist/kit.css` inline, followed by the colour overrides |
| `consent-kit/banner.html` | the reference markup (`kit/templates/banner.html`) with the strings of the page's language and the site's values |
| `consent-kit/script.html` | `<script data-cfasync="false" src="/consent-kit/kit.<sha256>.js" integrity="sha256-…" defer>`: `dist/kit.js`, fingerprinted, with Subresource Integrity |

The order and why: kit/README.md, Page structure. Pass the page (`.`) as the context: the partials read nothing from
it. Every `<script>` they emit carries `data-cfasync="false"`. The reopen link's text is the site's own string, not one of
the kit's (the example site's `cookieSettings`).

### A Content Security Policy with nonces

Pass the nonce in a dict instead of the page:

```go-html-template
{{ partial "consent-kit/head.html" (dict "nonce" $nonce) }}
…
{{ partial "consent-kit/script.html" (dict "nonce" $nonce) }}
```

The nonce goes on the inline head snippet, the `<style>` and kit.js; not on the config block, a data block that a CSP
does not govern. A nonce must be new for every response: on a static site, a placeholder that the server replaces in
each response. The record goes to the endpoint's host: allow it in `connect-src` (kit/README.md, The record).

## Minification

`hugo --minify` (or `minifyOutput = true` under `[minify]`) runs every page through Hugo's minifier, and the minifier
rewrites the module's inline parts as well:

- the head snippet: minified once more — other variable names, other bytes than `dist/head.js` — and, at the
  minifier's default ECMAScript version, with newer syntax than the kit's ES2017 (kit/README.md, Build output):
  `catch(h){}` becomes `catch{}`, an ES2019 form that an ES2017 engine cannot parse;
- the inline styles: the same rules in other bytes than `dist/kit.css`;
- the config block: the same JSON, its escapes of `<`, `>` and `&` kept;
- kit.js: untouched — a file of its own, published as built, so its integrity holds.

What the head snippet does stays the same: the tests build the example site with `--minify` and run its rewritten
head snippet over a stored choice. To keep it ES2017, set the minifier's JavaScript version in the site's
configuration:

```toml
[minify.tdewolff.js]
  version = 2017
```

To keep the head snippet and the styles byte for byte as shipped, switch the JavaScript and CSS minifiers off — for
the whole site, `resources.Minify` of the site's own files included:

```toml
[minify]
  disableJS = true
  disableCSS = true
```

Leave `[minify.tdewolff.json] precision` at its default, 0: a precision rounds the config block's numbers —
`precision = 1` writes `revision = 123456` as `1e5`, and no stored choice counts any more.

A Content Security Policy of a site that minifies allows the inline head snippet and styles with the nonce (above),
not with a hash: a hash of `dist/head.js` or `dist/kit.css` no longer matches the bytes the minifier writes. Only
with the two minifiers off does a hash of the shipped files hold.

## Parameters

`site.Params.consentKit`, checked when the site is built: a missing required key, an unknown key, a wrong type or
an invalid value fails the build with an error that starts with `consent-kit:`. An optional key is left out or set
to a valid value: `colors = false` or `legacy = ""` fails too (for `domain` and `site`, `""` is the same as left
out). Values for one language go to `[languages.<lang>.params.consentKit]`; Hugo merges them over
`[params.consentKit]`.

| Key | Required | Example | Meaning |
|---|---|---|---|
| `revision` | yes — an integer from 1 to 1,000,000 | `1` | the banner revision: raising it asks every visitor again (purge every cached page; kit/README.md, The stored choice) |
| `cookie` | yes — letters, digits, `_`, `.`, `-` | `"ck_consent"` | the name of the choice cookie |
| `domain` | no — a lower-case domain, no scheme, port or leading dot | `"example.com"` | the registrable domain: every cookie deletion is written once more with `Domain=<domain>` |
| `endpoint` | yes — an `https://` URL with a path, or `""` | `"https://consent.example.com/v1/record"` | where the records go; `""` = no records |
| `site` | with an endpoint — letters, digits, `_`, `.`, `-` | `"example-site"` | the site id in every record: one of the records service's `SITES` |
| `privacyUrl` | yes, for every language — an `https://` URL, a path that starts with one `/`, or a `#fragment` | `"/datenschutz/"` | the privacy policy, linked in both layers |
| `imprintUrl` | yes, for every language — the same three forms | `"/impressum/"` | the imprint, linked in both layers |
| `legacy` | no — a list of cookie names | `["previous-tool-consent"]` | a previous consent tool's cookies, deleted on every page load |
| `categories` | no | `{ analytics = "stats" }` | kit category (`analytics`, `marketing`) → the `data-consent` value it activates; a category left out keeps its own name |
| `cleanup` | no | see below | per category, what is deleted while it is not granted: `cookies` (exact names, or prefixes ending in `*`) and `localStorage` keys |
| `colors` | no | see below | colour tokens per theme (`light`, `dark`): `bg`, `fg`, `line`, `accent`, `wash`, `off`, `shade` — the `--ck-cc-*` tokens of kit/README.md, Theming |

Where they go: `revision`, `cookie`, `domain`, `categories`, `cleanup` and `legacy` make the config block
(kit/README.md, The config block); `endpoint` and `site` become the first layer's `data-endpoint` and `data-site`;
`privacyUrl` and `imprintUrl` the links of both layers; `colors` a rule after kit.css with the kit's own theme
selectors (`data-bs-theme`, then `prefers-color-scheme`).

The two links take one of the three forms in the table; anything else fails the build: a `javascript:` or `tel:`
value (html/template would write the dead link `#ZgotmplZ`), a `#fragment` with a colon (in `#abschnitt:1`,
html/template reads `#abschnitt` as a scheme: `#ZgotmplZ` again), `http://`, a relative path, a path that starts with
`//` or `/\` (to a browser, another host), a value with whitespace, a quote, `<`, `>` or a backslash. Neither link is
written as given: html/template writes it URL-normalised, a character outside the URL syntax percent-encoded —
`/datenschutzerklärung/` becomes `/datenschutzerkl%c3%a4rung/`, the same address.

A colour is a `#` hex colour of 3, 4, 6 or 8 digits (`#0b5394`), a colour name of letters only (`rebeccapurple`),
or one of the colour functions `rgb()`, `rgba()`, `hsl()`, `hsla()`, `hwb()`, `lab()`, `lch()`, `oklab()`,
`oklch()`, `color()` with letters, digits, spaces and `. % , / -` between its two parentheses
(`rgb(29 65 99 / 0.1)`, `oklch(0.6 0.1 250 / 50%)`). Nothing else passes — no parenthesis left open, no `;`, `{`,
`}`, `:` or quote, no `url()`, `image-set()`, `var()` or other nested function — so a value can neither leave its
declaration nor make the browser load anything before a choice.

The example site's block:

```toml
[params.consentKit]
  revision = 1
  cookie = "ck_consent"
  domain = "example.com"
  endpoint = "https://consent.example.com/v1/record"
  site = "example-site"
  legacy = ["previous-tool-consent"]

  [params.consentKit.cleanup.analytics]
    cookies = ["_ga", "_ga_*"]

  [params.consentKit.cleanup.marketing]
    cookies = ["_gcl_*"]
    localStorage = ["_gcl_ls"]

  [params.consentKit.colors.light]
    accent = "#0b5394"

  [params.consentKit.colors.dark]
    accent = "#9fc5e8"

[languages.de.params.consentKit]
  privacyUrl = "#datenschutz"
  imprintUrl = "#impressum"

[languages.en.params.consentKit]
  privacyUrl = "#privacy"
  imprintUrl = "#imprint"
```

## Your own texts

The module's `i18n/de.yaml` and `i18n/en.yaml` hold the kit's sample strings — samples for a site with an analytics
and an advertising service, not legal advice. A site supplies its own legally reviewed texts in its own translation
files, under the same ids: Hugo merges the site's translations with the module's by id, and the site's entry wins —
whether the file is the site's `i18n/de.yaml` or `i18n/de.toml`. Ids the site leaves out keep the module's sample.

| Id | Used as |
|---|---|
| `consentKit_title` | the first layer's `aria-label` |
| `consentKit_text` | the first layer's one paragraph |
| `consentKit_privacy`, `consentKit_imprint` | the link texts (both layers) |
| `consentKit_acceptAll`, `consentKit_rejectAll` | the decision buttons (both layers) |
| `consentKit_settings` | the first layer's button that opens the dialog |
| `consentKit_dialogTitle` | the dialog's heading |
| `consentKit_close` | the dialog's close button |
| `consentKit_analytics`, `consentKit_marketing` | the category names |
| `consentKit_analyticsDetails`, `consentKit_marketingDetails` | the category texts |
| `consentKit_saveChoice` | the dialog's save button |

```yaml
# i18n/de.yaml of the site
consentKit_text: "…"
consentKit_analyticsDetails: "…"
```

Other languages: Hugo gives a language without its own entry the string of the default content language, so give
every language of the site its own texts. A string that the default content language lacks as well fails the build.
A text must not contain `{{`: Hugo's translation library reads it as a template.

## Local development

To build a site against a local checkout of this repository instead of a downloaded version:

```sh
HUGO_MODULE_REPLACEMENTS="github.com/vitabef/consent-kit -> /absolute/path/to/consent-kit" hugo server
```

A relative path is resolved from the site's themes folder (`themes/` unless `themesDir` says otherwise). The site
reads the committed build output and the generated files, not the kit's sources: after a change to `kit/src/` or
`kit/templates/`, run `npm run build` in this repository.

## Example site

`adapters/hugo/exampleSite/` is a German and an English home page with the parameters above and the call order
(`layouts/_default/baseof.html`). From the repository root:

```sh
HUGO_MODULE_REPLACEMENTS="github.com/vitabef/consent-kit -> $PWD" hugo server -s adapters/hugo/exampleSite
```

Its `endpoint` is a placeholder host (`consent.example.com`), not a records service of yours: set `endpoint = ""` in
a local copy to send no records at all.

## Generated and hand-written files

| File | Origin |
|---|---|
| `layouts/partials/consent-kit/banner.html` | generated by `node kit/build.mjs` (`generate.mjs`) from `kit/templates/banner.html`: each `{{key}}` string becomes `{{ i18n "consentKit_key" }}`, each value the checked parameter |
| `i18n/de.yaml`, `i18n/en.yaml` | generated from `kit/src/i18n/de.json`, `en.json` |
| `layouts/partials/consent-kit/head.html`, `script.html`, `params.html` | hand-written |

Never edit a generated file: change the kit's source and run `npm run build`; a test fails while a committed copy
differs from a fresh generation.

## Releasing

A version is a git tag `vX.Y.Z` that equals `version` in `package.json`:

1. The change that makes the release raises `version` in `package.json` to `X.Y.Z`.
2. After it is merged, tag that commit on `main` with `vX.Y.Z` and push the tag.
3. Sites move to it with `hugo mod get github.com/vitabef/consent-kit@vX.Y.Z` and commit their `go.mod` and `go.sum`
   (Import and version).

## Tests

`adapters/hugo/test/hugo.test.ts`, part of `npm test` and the gate:

- the generated files are the committed copies of a fresh generation, and their YAML keeps every string and comment
  on its own line;
- with Hugo 0.141.0, the module's minimum, and with 0.169.0, the newest one tested (`mise x hugo-extended@<version>`;
  `adapters/hugo/test/hugo.mjs` names both), each against this checkout: the module's mounts are exactly the four
  above; the example site builds without a warning and carries the config block, the inline head snippet and styles
  with the colour overrides, the first layer and the dialog of both languages structurally equal to the reference
  rendering, and kit.js fingerprinted with a matching integrity; every accepted colour form reaches the overrides;
  built with `--minify`, its rewritten head snippet still reads a stored choice in happy-dom, and the minifier
  settings above do what Minification says; scratch sites prove the nonce, a site's own string winning, the link
  forms, the optional parameters left out and a config value that tries to close the config block; every check of
  the parameters, and a default language without strings, fails the build with its message.

Without one of the two Hugo versions extended in mise, its builds are skipped with a warning, and the gate says so
in its last line. `node adapters/hugo/test/hugo.mjs` prints which run.
