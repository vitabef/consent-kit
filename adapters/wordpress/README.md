# Consent kit — WordPress plugin

The kit for a WordPress site: a plugin that puts the HTML adapter's fragments into every page, filled from its
settings page, and reads the visitor's choice on the server with the PHP helper. Its templates and its copy of the
helper are generated from this repository's sources, so a WordPress page carries the same markup and the same
shipped bytes as a page of any other adapter. What the kit does, every attribute, the cookie and the record:
[kit/README.md](../../kit/README.md).

## Requirements

- Ran with WordPress 7.1.5 on PHP 8.3 ([Tests](#tests)); on PHP 8.1 its files are only syntax-checked. The header's
  `Requires at least: 5.9` and `Requires PHP: 8.1` are minimums set for the code, not versions it ran on.
- A theme that renders its pages with `wp_head()` and `wp_footer()`. One that also calls `wp_body_open()` right after
  `<body>` — WordPress's page frame for block themes does (the run's theme: Twenty Twenty-Five) — gets the first
  layer as the first thing in `<body>`. Without `wp_body_open()` the first layer comes last in `<body>`, right before
  kit.js: it works the same, but it is the last stop for the keyboard instead of the first.
- Multisite: the settings are each site's own; a site gets nothing until its own settings are saved, also when the
  plugin is network-activated.

## Install

From a clone of this repository at a release tag (the tag is the version):

1. Copy the folder `adapters/wordpress/consent-kit/` into the site's `wp-content/plugins/`, or zip it
   (`zip -r consent-kit.zip consent-kit` in `adapters/wordpress`) and upload it under Plugins › Add New Plugin ›
   Upload Plugin.
2. Activate **Consent Kit**. Until its settings are saved it puts nothing into any page.

**A new version** replaces the whole folder: the head snippet and kit.js ship as a pair
([kit/README.md, Page structure](../../kit/README.md#page-structure)), and the folder carries both. Then purge every
page cache — a caching plugin's, the server's, a CDN's: kit.js is named by its SHA-256, so the new folder brings a
new file name and no longer has the old file, and a cached page that still names the old one gets no kit.js and has
no working consent layer until it is purged.

The plugin is not on WordPress.org; its header sets `Update URI: false`, which per WordPress's description of that
header (5.8 and later) keeps WordPress.org from offering a plugin of the same folder name as its update — not checked
here.

## Configure

Settings › Consent Kit, for users who may manage options (`manage_options`). Each field is one key of the HTML
adapter's site config and takes the same values
([adapters/html/README.md, The site config](../html/README.md#the-site-config)):

| Field | Setting | Meaning |
|---|---|---|
| Revision | `revision` | an integer from 1 to 1,000,000; raising it asks every visitor again — purge every cached page then |
| Cookie name | `cookie` | the choice cookie: letters, digits, `_`, `.`, `-` |
| Cookie domain | `domain` | optional: the registrable domain (`example.com`), every cookie deletion is written once more on it |
| Statistics / Marketing: data-consent value | `categories.analytics`, `categories.marketing` | optional: the `data-consent` value a grant activates; empty keeps the category's own name |
| Statistics / Marketing: cookies, localStorage keys | `cleanup.<category>.cookies`, `cleanup.<category>.localStorage` | one per line: what is deleted while the category is not granted (a trailing `*` is a prefix) |
| Previous consent tool | `legacy` | one per line: its cookies, deleted on every page load |
| Records endpoint | `endpoint` | the records URL (`https://consent.example.com/v1/record`); empty: no records |
| Site id | `site` | the site id in every record, one of the records service's `SITES`; needed with an endpoint |
| Banner language | `language` | `de` or `en`: the language of the first layer, the dialog and the reopen link |
| Privacy policy, Imprint | `privacyUrl`, `imprintUrl` | an `https://` URL, a path that starts with one `/`, or a `#fragment`; the reopen link goes to the privacy policy |
| Server cleanup | `serverCleanup` | on: the cleanup's deletions in the page responses as well ([below](#server-cleanup)) |
| Texts: one field per string of the kit | `texts.<key>` | optional: the site's own text in the banner language — the HTML adapter's `languages.<lang>.texts`; empty keeps the kit's sample (below) |

Saving checks every value as the HTML adapter checks a site config — both run the same cases,
[`adapters/html/test/config-cases.json`](../html/test/config-cases.json) — and that WordPress's `esc_url()` keeps
each URL as given: it empties a `#fragment` with a `:` (`#a:b`) and drops a `{` or `}`, which would put a broken link
into the page. All through WordPress's Settings API (its nonce, the capability, a `sanitize_callback`): an invalid
value is refused with an error notice that names it, the saved settings stay as they were, and the form shows the
values as posted, once, to correct them. Settings that are invalid when a page is rendered — written with WP-CLI,
which passes the settings page, or left by an older version — make the plugin put nothing into the page and send
nothing, and read every visitor as undecided, as the kit does without a config; the settings page then says why. So
does a damaged file in the plugin's `i18n/`: install the plugin folder again.

WP-CLI: the option `consent_kit` holds the settings, the keys of the table; [`test/settings.json`](test/settings.json)
is the HTML adapter's example site config in that form:

```sh
wp option update consent_kit --format=json < settings.json
wp option patch insert consent_kit texts '{"acceptAll": "Accept all"}' --format=json   # own texts, while there are none
wp option patch update consent_kit texts acceptAll 'Accept all'                          # one of them, once there are
```

**The texts.** The section Texts has one field per string of the kit — the keys of
[kit/src/i18n/](../../kit/src/i18n/), `_note` excepted —, each with a note on where it shows
([kit/README.md, i18n](../../kit/README.md#i18n)). Each field shows the sample of the banner language as its
placeholder, and a field left empty keeps that sample. The samples are written for a site with an analytics and an
advertising service and are not legal advice: put the site's own, legally reviewed texts there. Only **First layer:
text** (`text`, the first layer's paragraph) has several lines: a line break starts a new block of the paragraph
([kit/README.md, The first-layer text in blocks](../../kit/README.md#the-first-layer-text-in-blocks)) — split a long
text at sentence boundaries. Every other text is one line (a line break written there with WP-CLI stays in it, and a
browser shows it as a space). **Dialog: title** (`dialogTitle`) also names the reopen link, which the first-layer text
sends visitors to: keep the two in step. The texts are one set, for the banner language: changing the language keeps
them. Saving checks them as the HTML adapter checks its `texts` — a key of the kit's strings only, a text that is more
than whitespace — and that each is UTF-8. The form trims a text at its ends (ASCII whitespace: spaces, tabs, line
breaks), as it trims every field; WP-CLI, like the HTML adapter, keeps a text as written.

## What goes into a page

| Hook | Emits | Why there |
|---|---|---|
| `wp_head`, priority `PHP_INT_MIN` | the Consent Mode defaults, then the config block, the inline head snippet and the inline styles: the HTML adapter's `consent-mode.html` and `head.html` | the first output of `wp_head()`: the defaults have to come before any tag's own code. Only two things come earlier: what the theme writes into `<head>` before it calls `wp_head()` (its `<meta charset>`, a hard-coded tag), and another callback on the same priority that was added before this one |
| `wp_body_open`, priority `PHP_INT_MIN` | the first layer and the settings dialog: `<lang>/banner.html`, once per page also when a theme calls `wp_body_open()` twice | first in `<body>`, before the toolbar (`wp_admin_bar_render`, priority 0) and a theme's skip link: the first keyboard stop, painted with the page |
| `wp_footer`, priority `PHP_INT_MAX` | kit.js, deferred, with its integrity: `script.html` — for a theme without `wp_body_open()`, the first layer and the dialog right before it | last before `</body>`, after the footer scripts (`wp_print_footer_scripts`, priority 20) |
| the shortcode `[consent_kit_link]`, the function `consent_kit_footer_link()` | the reopen link: `<lang>/footer-link.html` | in the footer of every page — the first-layer text sends visitors there; WordPress expands shortcodes in a block theme's template parts too, its footer included |
| `send_headers` | the server cleanup's header fields | before the response's output ([Server cleanup](#server-cleanup)) |

- **The fragments** are the HTML adapter's: the plugin's `fragments/` folder is the HTML adapter's output
  (`fragments()` in `adapters/html/generate.mjs`) with placeholders as the site's values — the first layer and the
  dialog are the reference markup with the strings as placeholders too, the reopen link has its text as one — and
  the plugin fills them on every page: each URL with `esc_url()`, the site id with `esc_attr()`, each text — the
  site's own or the sample — as the HTML adapter fills it (`renderBanner()` in `kit/build.mjs`: `&`, `<`, `>` and `"`
  escaped, the first-layer text in blocks; not with `esc_html()`, which writes `'` as `&#039;` and keeps an entity as
  written), the config block with the settings as JSON in which every `<` is escaped, as the HTML adapter writes it,
  so no value can close the element; `cleanup` and its rules are JSON objects there, as in the HTML adapter, although
  PHP reads a stored `{}` as `[]`. For the HTML adapter's example values the page carries its fragments byte for byte,
  and with the same own texts the HTML adapter's fragments for them. Other values can differ in their bytes only where
  WordPress writes a character in another form, for the same URL: `esc_url()` writes an `&` as `&#038;`.
- **kit.js** comes from the plugin folder's URL (`plugins_url()`):
  `…/wp-content/plugins/consent-kit/fragments/consent-kit/kit.<sha256>.js`, named by its SHA-256. It is on the pages'
  origin only while that URL has their scheme, host and port (`home_url()`): WordPress builds it from the site
  address and `WP_CONTENT_URL`, and CDN plugins rewrite it. From another origin a browser blocks it — the tag carries
  an integrity value and, as the HTML adapter's, no `crossorigin` — and no visitor can decide (the head snippet hides
  the first layer at `load`, nothing is granted); the settings page then says so. A plugin, server step or CDN that
  minifies, combines or moves kit.js breaks its integrity the same way: leave it out of such optimisations.
- **Optimisation plugins** that delay, defer, combine or move inline scripts — WP Rocket, LiteSpeed Cache,
  Autoptimize and the like — must leave out the three inline elements: the Consent Mode defaults, the config block
  and the head snippet. Delayed or moved behind a Google tag that is not gated, the defaults come too late, and that
  tag treats storage as granted; a rewritten element no longer matches its CSP hash either.
- **The styles** are inlined as `head.html` inlines them, so the first layer is styled at its first paint.
- **A Content Security Policy**: the three inline elements are the HTML adapter's bytes, so the same `'sha256-…'`
  hashes allow them ([adapters/html/README.md, What to change](../html/README.md#what-to-change)); kit.js is
  `'self'`; the endpoint goes into `connect-src`.
- **Gated tags**: a tag that needs consent goes into the page as `<script type="text/plain" data-consent="…">`
  ([kit/README.md, Script gating](../../kit/README.md#script-gating)), on every page, decided or not.

## Reading the choice on the server

`consent_kit_verdict()` returns the PHP helper's `ConsentKit\Verdict` — `decided`, `analytics`, `marketing` — for the
current request: the choice cookie read from its `Cookie` header exactly as the head snippet reads it
([spec/consent-cookie.md](../../spec/consent-cookie.md)), with the plugin's own settings. A theme or another plugin
gates what it sets itself with it:

```php
if (function_exists('consent_kit_verdict') && consent_kit_verdict()->analytics) {
    setcookie('visits', '1', ['path' => '/', 'secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
}
```

- Undecided denies every category; without valid settings every request reads undecided.
- Put such a cookie under its category's cookies in the settings, so a denial deletes it.
- A response whose content depends on the verdict belongs to one visitor: keep it out of shared and page caches
  (`Cache-Control: private`).
- Never let the verdict change the kit's parts or the gated tags of a page: the browser decides those
  ([spec/consent-cookie.md, What a server must not do](../../spec/consent-cookie.md#what-a-server-must-not-do)).

### Server cleanup

With **Server cleanup** on, the responses that run WordPress's main query (`send_headers`, at the end of `wp()`) —
pages, posts, archives, search results, 404 pages, feeds — carry the PHP helper's deletions: the request's cookies
that a denied category's cookies name — undecided included — and the previous tool's cookies, each on the host, on
the cookie domain and on the site's host name (from `home_url()`, never the request's `Host` header). Only under the
helper's own conditions ([adapters/php/README.md](../php/README.md)): an https request (`HTTPS`, `REQUEST_SCHEME` or
`X-Forwarded-Proto`), no cross-site request other than a top-level `GET` navigation, at most 2 KB of deletions; any
other request deletes only the previous tool's cookies. A response with deletions also gets
`Cache-Control: private`, added to what the site sends. Not covered: the REST API (it answers before `send_headers`),
a `304` answer to a conditional request, the admin, `admin-ajax.php`, `wp-login.php`, `wp-cron.php`, and a page that
a cache serves without running WordPress — the kit's own cleanup runs in the browser on every page anyway.

**With a page cache that stores and replays response headers** — a caching plugin, a reverse proxy, a CDN that
caches pages — leave the server cleanup off: the deletions follow one visitor's cookies, and such a cache could
replay them to everyone, deleting the cookies of visitors who granted. `Cache-Control: private` asks caches not to
store such a response, but not every page cache honours it.

## What it does not do

- **Several languages**: one banner language, with one set of texts, for the whole site.
- **Write the choice cookie**: the kit is its only writer, and every decision there sends a record; the server reads
  it only.
- **Rewrite other plugins' tags** into gated ones: that stays the site's (above).
- **Its own Consent Mode defaults**: they are the kit demo's, everything denied; a site that sets defaults elsewhere
  too gets both, and both deny.
- **Clean up after itself**: deleting the plugin leaves the option `consent_kit` (`wp option delete consent_kit`).
- **Translate its settings page**: it is English.

## Generated and hand-written files

| File | Origin |
|---|---|
| `consent-kit/fragments/` | generated by `node kit/build.mjs` (`generate.mjs`): the HTML adapter's fragments with the placeholders `{{privacyUrl}}`, `{{imprintUrl}}`, `{{endpoint}}`, `{{site}}`, `{{kitPath}}`, the config block's JSON string `"{{config}}"` and each string's (`{{title}}`, `{{text\|blocks}}`, …) — one `banner.html` and one `footer-link.html` for every language —, and kit.js under its SHA-256 name |
| `consent-kit/i18n/` | generated: `kit/src/i18n/` byte for byte — the kit's languages and sample strings, for every text a site leaves out |
| `consent-kit/helper/` | generated: `adapters/php/src/` byte for byte — so without the `ABSPATH` guard of the plugin's own files: they only declare classes, and a direct request for one runs nothing else |
| `consent-kit/consent-kit.php` | hand-written: the hooks, the settings page and the public functions — wiring only |
| `consent-kit/includes/Site.php` | hand-written: the logic — the settings checks, the form and its save, the server cleanup's header fields, the fragments filled |

Never edit a generated file: change the source and run `npm run build`, which replaces the three folders, and writes
`test/texts/`, the HTML adapter's rendering of the tests' texts fixture; a test fails while a committed copy differs
from a fresh generation.

## Tests

- **`test/wordpress.test.ts`** (`npm test`, the gate): the generated folders are one fresh generation and nothing
  else, and `test/texts/` is the HTML adapter's rendering of [`test/texts.json`](test/texts.json); every placeholder
  in the templates is one that `includes/Site.php` fills, as often as the markup has it; every string of the kit has
  a field with a label and a note on the settings page, and no label is used twice; the plugin's version is the
  kit's.
- **`test/SiteTest.php`** (PHPUnit, the gate's PHP step):
  - the settings checks with every case of [`adapters/html/test/config-cases.json`](../html/test/config-cases.json) —
    the HTML adapter's own cases, which its tests run too, so a new check there fails here until it is ported — and
    the plugin's own (no saved settings, the server cleanup's switch, values that are not UTF-8, JavaScript's
    whitespace in a URL), and a damaged `i18n/` file refused as invalid settings are;
  - the URLs `esc_url()` would change, the form's fields as settings and their save (the second run of a first
    save included), the server cleanup's header fields, the origin check;
  - the fragments of [`test/settings.json`](test/settings.json) equal to the HTML adapter's committed example byte
    for byte (both languages, the sample strings), and with the own texts of `test/texts.json` — a `</script>`,
    quotes and apostrophes, an `&` and an entity, a `{{placeholder}}` as text, a first-layer text in two blocks —
    equal to `test/texts/`; `cleanup` written as objects, values that try to close the config block or leave an
    attribute, the texts' form fields and their save.

  WordPress's two escaping functions stand in as `htmlspecialchars()` ([`test/bootstrap.php`](test/bootstrap.php)).
  It runs with the PHP helper's dev install: `composer install` in `adapters/php`, then, from the repository root,
  `php adapters/php/vendor/bin/phpunit --configuration adapters/wordpress/phpunit.xml.dist`.
- **`test/run.sh`** — by hand, never in the gate: `sh adapters/wordpress/test/run.sh` needs Docker with Compose v2
  and curl. It starts WordPress 7.1.5 on PHP 8.3 with `WP_DEBUG` and MariaDB 11.8
  ([`test/compose.yaml`](test/compose.yaml)), installs WordPress with WP-CLI, activates the plugin (mounted
  read-only) and checks with curl:
  - nothing in the page before the settings are saved;
  - with `test/settings.json`: the HTML adapter's `consent-mode.html` and `head.html` right after `<meta charset>`,
    `en/banner.html` as the first child of `<body>` (before the toolbar for a logged-in admin), its `script.html` as
    the last line before `</body>`, each byte for byte, and no PHP notice; the first layer once when
    `wp_body_open` runs twice, and right before kit.js when it does not run; kit.js byte for byte `dist/kit.js`, its
    SHA-256 the integrity value; the shortcode and `consent_kit_footer_link()` as `en/footer-link.html`;
  - `consent_kit_verdict()` for no cookie, granting, denying and mixed copies and another revision (a test endpoint,
    [`test/mu-plugin.php`](test/mu-plugin.php));
  - the server cleanup's deletions and `Cache-Control: private` with `X-Forwarded-Proto: https`, the previous tool's
    cookie only on plain http, for a granting choice and for a cross-site frame, nothing with the switch off;
  - invalid saved settings failing closed, links that `esc_url()` empties or rewrites among them, with the reason on
    the settings page; a value that tries to close the config block;
  - the own texts of `test/texts.json`: the first layer, the dialog and the reopen link as `test/texts/`, byte for
    byte; a text of spaces only failing closed, without a PHP error;
  - the settings page: the form — 30 fields, no label twice, its Texts fields empty, the samples as placeholders —,
    an invalid value refused with an HTML-escaped notice and the posted values kept, a valid first save stored
    exactly, a text of no-break spaces refused, an own text saved and shown escaped in both layers, a text with an
    entity as written (`&amp;`) shown as written in its field and kept by the next save, a wrong nonce and a
    subscriber refused with 403, the warning for kit.js from another origin.

  It writes only below `.tmp/wordpress-test/` and removes its containers and volumes at the end, after a failure
  too; `CONSENT_KIT_WP_PORT` moves it off `127.0.0.1:8890`.
