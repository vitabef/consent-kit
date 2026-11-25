# Consent kit — PHP helper

Reads the kit's stored choice on a PHP server, from the request's `Cookie` header, exactly as the head snippet reads
it ([spec/consent-cookie.md](../../spec/consent-cookie.md)): a server can then gate what it sets itself — an optional
cookie, a server-side tag or measurement call, an embed — and send the kit's cleanup as `Set-Cookie` deletions. PHP
8.1 or later, no dependency, no extension beyond PHP's JSON and PCRE. It passes every case of the shared
[test vectors](../../spec/vectors.json). The config, the cookie and the cleanup: [kit/README.md](../../kit/README.md).

## Install

From a clone of this repository at a release tag (the tag is the version), either way:

- **Copy** `adapters/php/src/` — three files, namespace `ConsentKit` (PSR-4) — into the site and load them with its
  autoloader, or `require` `Config.php`, `Verdict.php` and `ConsentCookie.php`.
- **Composer**, from the clone as a path repository (the package is not published):

  ```json
  {
    "repositories": [{ "type": "path", "url": "../consent-kit/adapters/php" }],
    "require": { "vitabef/consent-kit-php": "*@dev" }
  }
  ```

## Use

```php
<?php
use ConsentKit\Config;
use ConsentKit\ConsentCookie;

require __DIR__ . '/vendor/autoload.php';

$config = Config::fromJson(file_get_contents(__DIR__ . '/site.json')); // null: no config, undecided
$verdict = ConsentCookie::verdictFromGlobals($config);                  // $_SERVER['HTTP_COOKIE']
header('Cache-Control: private');                                       // this answer depends on the visitor's cookies
ConsentCookie::sendDeletionHeaders($verdict, $config, 'www.example.com'); // the cleanup, before any output
if ($verdict->analytics) {
    setcookie('visits', '1', ['path' => '/', 'secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
}
```

- **The config** — `Config::fromJson($json)`, or `Config::fromArray($values)` for decoded values — comes from the
  source the pages' config block comes from: here the HTML adapter's `site.json`
  ([adapters/html/README.md](../html/README.md)), or the block's own JSON, so a `revision` bump reaches both. It is
  valid when `cookie` is a non-empty string and `revision` a number with an integer value from 1 to 1,000,000 (the head
  snippet's rule), and when, if set, `domain` is a lower-case domain (no scheme, port or leading dot), `cleanup` an
  object whose `analytics` and `marketing` rules hold a list of `cookies` — names of letters, digits, `_`, `.` and `-`,
  or such a prefix ending in `*` — and `legacy` a list of such names; anything else is no config. Every other key
  (`localStorage`, `categories`, `endpoint`…) is ignored.
- **The verdict** — `decided`, `analytics`, `marketing`, read-only — is undecided, every category denied, without a
  config or a valid copy of the choice cookie. `ConsentCookie::verdict($config, $cookieHeader)` takes the header
  itself; several `Cookie` field lines (HTTP/2, HTTP/3) are their values joined by `"; "`, never by `,`.
- **The cleanup**: for each denied category, the request's cookies that match its `cleanup.<category>.cookies` (an exact
  name, or a prefix ending in `*`), and the `legacy` cookies, each deleted on the host, on `domain` and on the page's
  host name — the kit's own three deletions. Pass the site's own configured host name (from the server config, for
  example) rather than an unvalidated `Host` header such as `$_SERVER['HTTP_HOST']`: the helper checks only its syntax
  — a port and a trailing dot are dropped, a value that is no host throws — not that the host is the site's. Put a
  cookie the server sets under its category's `cleanup` cookies (here `visits` under `analytics`), so a denial
  deletes it. One response deletes whole cookies in request order up to 2,048 bytes of `Set-Cookie` fields (about
  eight cookies in three scopes): nginx reads a FastCGI or proxied answer's headers into one buffer of a memory page,
  4 KB on most platforms, and answers 502 past it. The rest, and a name that is no RFC 6265 token (no `Set-Cookie`
  field can carry it), are left to the kit's own cleanup at the next page load.
- **Not on every request**: a plain-http request carries no choice cookie (the kit writes it `Secure` on https), nor
  does a cross-site request other than a top-level `GET` navigation (`SameSite=Lax`): each reads undecided whatever
  the visitor chose, while it still carries their tag cookies. `ConsentCookie::mayCleanUp($_SERVER)` is true only for
  an https request (`HTTPS`, `REQUEST_SCHEME` or `X-Forwarded-Proto`) that Fetch Metadata does not show as such a
  cross-site one; `sendDeletionHeaders()` applies it and otherwise deletes only the `legacy` cookies. Behind a proxy
  that ends TLS and passes none of the three, set `$_SERVER['HTTPS'] = 'on'` for its https requests before the call
  (or have the proxy send `X-Forwarded-Proto: https`). In a framework, call
  `ConsentCookie::deletionHeaders($verdict, $config, $hostname, $cookieHeader, $mayCleanUp)` and add each value it
  returns as a `Set-Cookie` header of its own (PSR-7: `withAddedHeader('Set-Cookie', $value)`).

How it reads the cookie: the raw header, never `$_COOKIE` (which reads `+` as a space, turns a `.` in a name into `_`
and keeps one value per name); the name as a literal prefix, not a regular expression; only spaces and tabs trimmed;
`rawurldecode()` after every `%` escape is checked, then UTF-8; the JSON with `json_decode()` (arrays; it reads 1,023
nested arrays and objects and refuses 1,024; every number compared as a float). A copy the head snippet may read
although the helper cannot — raw bytes that are not UTF-8, JSON refused for an escaped unpaired surrogate or its
depth — counts as denying both categories, never skipped, so another copy cannot grant what the browser denies (spec
§§ 3, 4).

## What it does not do

- **Write the choice cookie**: it never sets, refreshes or deletes the configured cookie, not even when a `cleanup`
  pattern or a `legacy` name matches it. The kit is its only writer, and every decision there sends a record.
- **Render the kit**: the config block, the head snippet, the first layer and the dialog go into every page, decided or
  not, and gated tags stay `type="text/plain"` for the kit to activate — the HTML adapter writes those fragments.
- **The browser's part**: `cleanup.<category>.localStorage` (kit.js removes those keys) and Global Privacy Control (a
  GPC visitor without a stored choice reads undecided: denied, as in the kit).
- **Output**: apart from `sendDeletionHeaders()`, nothing calls `header()` or prints; caching is the site's —
  `Cache-Control: private` (or `no-store`) for every answer whose content or `Set-Cookie` fields depend on the verdict.

## Tests

In `adapters/php`: `composer install` (PHPUnit, the one dev dependency; `vendor/` and `composer.lock` are
git-ignored — a library pins no lock file), then `composer test`. Run on PHP 8.1 with PHPUnit 10.5 and on PHP 8.5
with PHPUnit 12.5.

- `test/VectorsTest.php`: every case of `spec/vectors.json`, and their count, so a new case is counted in; raw and
  escaped bytes that are not UTF-8, which no JSON vector can carry.
- `test/ConfigTest.php`: the config's checks. `test/CleanupTest.php`: the deletions — the three scopes, prefixes,
  cookies the request lacks, a granted category, the legacy cookies, no config, the choice cookie, names no header can
  carry, the host name, the 2 KB cap, `deletionHeadersFromGlobals()` — and `mayCleanUp()` (https, Fetch Metadata).

The repository's gate (`scripts/pre-push-gate.sh`) runs the suite where PHP and this dev install are present; without
them it skips it and says so in its last line.
