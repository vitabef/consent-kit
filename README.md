# consent-kit

A small, self-hosted cookie-consent banner and consent-record service — an alternative to hosted consent platforms.

- **Kit** — a tiny inline head snippet, a server-rendered first layer, one deferred script and one stylesheet. The
  built files are copied into each website (same origin), so the kit loads nothing from another host and showing the
  banner costs no extra connection. After a decision it sends one record to the records service's own host (e.g.
  `consent.example.com` — another origin for every site, a cross-site one for every site outside that host's
  registrable domain): a site with a Content Security Policy must allow that endpoint in `connect-src`.
- **Records service** — a Cloudflare Worker that stores one anonymous record per consent decision (banner version,
  choice, action, language, time — no IP address, no visitor id) in a database located in the EU, keeps it for three
  years and shows daily counts on an admin page.

How a site embeds the kit: [kit/README.md](kit/README.md). This file covers the repository, the records service, its
configuration, deploy and admin access.

## Status

Version 0.1.0, maintained for the maintainer's own sites. There is no support, and issues and pull requests are not
accepted. Security reports: [SECURITY.md](SECURITY.md).

## Requirements

- Node.js `^22.13.0 || >=23.4.0` (`engines` in `package.json`).
- A Cloudflare account with Workers, D1, Rate Limiting and Zero Trust Access.

## What it is

### The kit (`kit/`)

| Piece | Source | Goes into a page as |
|---|---|---|
| Head snippet | `kit/src/head.js` → `dist/head.js` | inline `<script data-cfasync="false">` in `<head>` |
| Styles | `kit/src/kit.css` → `dist/kit.css` | inline `<style>` in `<head>` |
| First layer + settings dialog | `kit/templates/banner.html` + `kit/src/i18n/*.json` | server-rendered markup, first in `<body>` |
| Logic | `kit/src/kit.js` → `dist/kit.js` | one same-origin `<script data-cfasync="false" defer>` |

No dependency at runtime, no network request before a decision. After a decision the kit stores the choice in a
first-party cookie, updates Google Consent Mode, activates the granted `type="text/plain"` scripts and sends one record
to the records service.

### The records service (`worker/`)

A Hono Worker, reachable only on its custom domain (`routes` in the [configuration](#configuration)):

| Route | What |
|---|---|
| `POST /v1/record` | the kit's decision records — always `204` ([details](#post-v1record)) |
| `GET /admin` | daily counts, behind Cloudflare Access ([details](#admin-page)) |
| cron `17 * * * *` | the 3-year retention prune ([details](#retention)) |
| anything else | `404` |
| an error no route catches | a bare `500` with `Cache-Control: no-store` — on `/admin` with the admin page's headers |

### Privacy properties

- **No IP address stored.** A row holds the site id, the banner revision, two 0/1 category flags, the action, the page
  language and the server's time (`migrations/0001_consent_records.sql`). The client address (`CF-Connecting-IP`) only
  forms the rate-limit keys. Failure log lines never carry the body or the address.
- **No visitor id.** Neither the record nor the kit's cookie carries one; the kit sends the record with
  `credentials: "omit"`; the Worker reads no cookie and sets none.
- **EU database.** The D1 database bound as `CONSENT_DB`, created with jurisdiction `eu`
  (`wrangler d1 create <name> --jurisdiction eu`).
- **Observability off** (`[observability] enabled = false`): no request logs, because the privacy policy promises that
  the address is used for 60 seconds only (the rate-limit keys) and stored nowhere. The Worker's warn and log lines are
  not kept either: they exist only in a live `npx wrangler tail`.
- **Three years**, then the hourly prune deletes the record.

## Use with Hugo

The repository is also a Hugo module (`go.mod`, `hugo.toml`). A Hugo site imports `github.com/vitabef/consent-kit`,
pinned to a version (`hugo mod get github.com/vitabef/consent-kit@vX.Y.Z`), sets `params.consentKit` and calls three
partials: `consent-kit/head.html` right after its Google Consent Mode defaults, `consent-kit/banner.html` first in
`<body>`, `consent-kit/script.html` right before `</body>`. The module mounts only the partials, the sample strings and
the committed build output `dist/` — the same files any other site vendors. Parameters, own texts, versions and
local development: [adapters/hugo/README.md](adapters/hugo/README.md).

## Repository layout

| Path | What |
|---|---|
| `kit/src/head.js`, `kit/src/kit.js`, `kit/src/kit.css` | the kit's three shipped files (sources) |
| `kit/src/i18n/de.json`, `en.json` | the reference strings — sample wording; a site supplies its own texts |
| `kit/templates/banner.html` | the reference markup: first layer + settings dialog |
| `kit/build.mjs` | the build: minify into `kit/dist/` (git-ignored) and `dist/`, write the Hugo adapter's generated files, brotli budgets, demo pages |
| `kit/demo/` | a fake host page for local development (never deployed) |
| `kit/test/` | `kit.test.ts` runs the minified kit in happy-dom; `build.test.ts` checks budgets, the committed `dist/`, strings, markup |
| `kit/README.md` | the site integration guide |
| `dist/` | the three shipped files, minified — committed, written by the build: what a site vendors and the Hugo module mounts |
| `go.mod`, `hugo.toml` | the Hugo module: its path, its minimum Hugo version and its mounts |
| `adapters/hugo/` | the Hugo adapter: partials, sample strings, an example site, tests ([adapters/hugo/README.md](adapters/hugo/README.md)) |
| `worker/src/index.ts` | the Worker: the two routes, the 404 fallback, the error answer, the cron handler |
| `worker/src/record.ts`, `contract.ts`, `body.ts` | `POST /v1/record`: handler, record contract + rate-limit keys, bounded body reader |
| `worker/src/records-db.ts`, `scheduled.ts` | the table's insert, prune and admin read; the hourly cron |
| `worker/src/admin.tsx`, `access.ts` | `GET /admin` and its Cloudflare Access check |
| `worker/src/env.ts` | the bindings and vars |
| `worker/test/` | Worker tests in node; `helpers/sqlite-d1.ts` puts `node:sqlite` behind the D1 calls the Worker uses |
| `migrations/` | D1 migrations of the records database (`0001_consent_records.sql`) |
| `wrangler.toml` | the Worker's reference configuration, with example values ([Deploy](#deploy)) |
| `tsconfig.json`, `tsconfig.test.json` | type checking: the Worker source; the tests and `vitest.config.ts` |
| `scripts/pre-push-gate.sh` | the local quality gate |

## Local development

```sh
npm ci          # install (package-lock.json)
npm run gate    # the local gate: sh scripts/pre-push-gate.sh
```

The gate runs five steps and stops at the first failure (exit code 0 = push-ready):

1. **Typecheck** — `tsc --noEmit` over `worker/src/`.
2. **Typecheck the tests** — `tsc -p tsconfig.test.json --noEmit` over `worker/test/`, `kit/test/`,
   `adapters/*/test/` and `vitest.config.ts`.
3. **Hugo** — `node adapters/hugo/test/hugo.mjs`: is Hugo 0.141.0 extended available through mise
   (`mise x hugo-extended@0.141.0`)? Without it the Hugo adapter's build tests are skipped; the gate says so here and
   in its last line.
4. **Tests** — `vitest run`: `kit/test/`, `adapters/hugo/test/` and `worker/test/`. They fail while the committed
   `dist/` or the Hugo adapter's generated files differ from a fresh build. The Worker tests need a Node.js whose
   built-in `node:sqlite` module needs no flag: 22.13 or later in the 22 line, 23.4 or later (`engines` in
   `package.json`).
5. **Kit build + brotli budgets** — `node kit/build.mjs` writes `kit/dist/`, `dist/` and the Hugo adapter's generated
   files, and exits 1 when a file is over its brotli budget: `head.js` 900 B, `kit.css` 2,200 B, `kit.js` 2,500 B
   (actual sizes in `kit/dist/sizes.json`).

Single steps: `npm run typecheck` (both type checks), `npm test`, `npm run build`. After a change to `kit/src/` or
`kit/templates/`, run `npm run build` and commit `dist/` and the regenerated files in `adapters/hugo/` with it.

**Demo page.** After a build, serve `kit/dist/` as the web root with any static server and open `demo/index.html`
(German) or `demo/en/index.html` (English). It is a fake host page with the kit emitted the way a site adapter emits it:
a Light / Dark / Auto theme switch, a status line with `consentKit.get()` and how often the gated stand-in script
(`demo/fake-analytics.js`) ran. Its `data-endpoint` is empty, so it sends no records. It asks for the host font under
`/fonts/` and falls back to the system font without it.

## Records service

### `POST /v1/record`

| | |
|---|---|
| Path | exactly `/v1/record` — `/v1/record/` or any other method answers `404` |
| Body | a JSON object as text; the kit sends it as `text/plain` (the content type is not checked) |
| Size | at most **512 bytes** are read: a declared `Content-Length` above that is never read, an undeclared body is abandoned past 512 bytes |
| `site` | one of the ids in `SITES` |
| `v` | the banner revision: an integer from 1 to 1,000,000 |
| `a`, `m` | the number `0` or `1` — statistics / marketing granted |
| `action` | `accept` \| `reject` \| `save` \| `withdraw` (`withdraw` = a granted category was denied) |
| `lang` | `de` \| `en` |
| Other keys | ignored, never stored; a duplicated key counts with its last value |
| Answer | **always `204` with no body** — stored or not, the caller never learns why; no cookie is read or set, no CORS headers |
| Stored | `site`, `revision`, `analytics`, `marketing`, `action`, `lang` and `created_at` (the server's time, ISO 8601 UTC) |

Checks, in this order — any failure drops the record and still answers `204`: the bounded read → `SITES` not empty
(an empty list is logged, on every request) → strict validation of every field → `CONSENT_DB` bound → a client address
present → all three rate-limit bindings bound → the three limits → the INSERT (under `waitUntil`).

Trust boundary: the endpoint is public and unauthenticated, every field is client-set, and `Origin` arrives as `null`
(a site with `Referrer-Policy: no-referrer`). A record proves that a decision was reported, not by whom; the `SITES`
list is a filter, not a gate.

### Rate limits

Three Workers Rate Limiting bindings, asked in this order; the first refusal drops the record. Counted per Cloudflare
location, eventually consistent.

| # | Binding | Namespace | Limit | Key |
|---|---|---|---|---|
| 1 | `CONSENT_ADDR_LIMIT` | `1001` | 10 per 60 s | `consent:<IPv4 address>` or `consent:<IPv6 /64>` |
| 2 | `CONSENT_PREFIX_LIMIT` | `1002` | 60 per 60 s | `consent48:<first three hextets>` — IPv6 only |
| 3 | `CONSENT_RATE_LIMIT` | `1003` | 300 per 60 s | `consent:all` — one global key, the circuit breaker, asked last |

The key comes from the first entry of `CF-Connecting-IP`, trimmed and lower-cased: an IPv6 address by its /64 (`::`
expanded, leading zeros dropped), an IPv4-mapped IPv6 address by the embedded IPv4 (then without a prefix key). No
address → the record is dropped. The /48 limit sits above the per-client one because a carrier's /48 is shared by many
subscribers; the breaker is asked last so that one flooding address or prefix is refused by its own key.

Accepted residual risk (`worker/src/record.ts`): a distributed flood (many addresses, many /48s) can write up to the
breaker's cap per location — billed D1 writes and junk rows, kept for three years like real ones — and real decisions at
that location beyond the cap are dropped while it lasts. A token spent at an earlier key stays spent when a later key
refuses.

### Retention

The hourly cron (`17 * * * *`) deletes the records older than three calendar years (UTC), oldest first, at most 5,000
rows per run, and logs the count when it deleted any. It is idempotent; a failure is logged and the next run retries.
Without `CONSENT_DB` there is nothing to prune.

### Admin page

`GET /admin` (exactly this path; `HEAD` passes the same check) shows the German page „Einwilligungen
(Cookie-Banner)“:

- per Europe/Berlin day for the last 30 days, today first: the count per action (Akzeptiert, Abgelehnt, Auswahl
  gespeichert, Widerrufen), the total, and the share of records with Statistik / Marketing granted;
- the 30-day totals: all decisions, each action, both shares (with „x von y“);
- the allowed site ids (`SITES`).

Without a valid Cloudflare Access token the answer is a plain `403 Forbidden` and the database is never read
([Admin access](#admin-access-via-cloudflare-access)). The token's issuer is checked too: its `iss` must be
`https://<ACCESS_TEAM_DOMAIN>`. Without `CONSENT_DB`, or before the migration, the page says
„Keine Daten“ and why; a failed read shows an error notice. Every response — an unexpected error's bare `500` included
— carries `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer` and the CSP
`default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` (no
script at all). The page has no export; for a copy of the table:
`npx wrangler d1 export <database-name> --remote --config <your-config> --output <file>.sql`.

## Configuration

Everything lives in the Wrangler configuration: `wrangler.toml` here, with example values, and a deployment's private
copy of it ([Deploy](#deploy)). Every binding is optional in the code (`worker/src/env.ts`) and **deny by default**: a
missing or failing piece drops records or refuses the admin page — it never lets more through. The Worker reads no
secrets.

| Key | Value | Missing / empty means |
|---|---|---|
| `name`, `main` | `consent-kit`, `worker/src/index.ts` | — |
| `compatibility_date`, `compatibility_flags` | `2025-01-01`, `["nodejs_compat"]` (the runtime the records code was built and tested with) | — |
| `workers_dev`, `preview_urls` | `false`, `false` — no `*.workers.dev` URL, no preview URLs | — |
| `routes` | the records host, `custom_domain = true` — the only address (example: `consent.example.com`) | — |
| `[[d1_databases]]` `CONSENT_DB` | the EU database's name and id (example: `consent-records` with an all-zero placeholder id), `migrations_dir = "migrations"` | every record dropped; the prune does nothing; the admin page says „Keine Daten“ |
| `[[ratelimits]]` `CONSENT_ADDR_LIMIT` | namespace `1001`, 10 per 60 s | any of the three missing or throwing: the record is dropped |
| `[[ratelimits]]` `CONSENT_PREFIX_LIMIT` | namespace `1002`, 60 per 60 s | 〃 |
| `[[ratelimits]]` `CONSENT_RATE_LIMIT` | namespace `1003`, 300 per 60 s | 〃 |
| `[triggers]` `crons` | `["17 * * * *"]` — hourly, off the top of the hour | — |
| `[vars]` `SITES` | comma-separated site ids, each trimmed, blanks dropped (example: `"example-site"`) | every record dropped (logged) |
| `[vars]` `ACCESS_TEAM_DOMAIN` | `""` — the Access team domain `<team-name>.cloudflareaccess.com` | every `/admin` request answers `403` |
| `[vars]` `ACCESS_AUD` | `""` — the Access application's AUD tag | every `/admin` request answers `403` |
| `[observability]` `enabled` | `false` — no request logs | — |

The rate-limit `namespace_id`s are unique per account: a deployment uses three that no other Worker in its account uses
(`1001`–`1003` in the example). Change vars in the config file, not in the dashboard: per Cloudflare's documentation,
`wrangler deploy` overrides variables changed in the dashboard unless `keep_vars` is set
([Wrangler configuration › Source of truth](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth)),
and the example config does not set it.

## Deploy

`wrangler.toml` in this repository is the reference configuration: its route (`consent.example.com`), its database
(`consent-records`, an all-zero placeholder id) and its site id (`example-site`) are examples that keep the tests and a
dry run working — it deploys nothing real. A deployment keeps a private copy of it (outside the repository, or in the
git-ignored `deploy/` folder) with:

- its host in `routes`;
- its D1 database, created in the EU — `npx wrangler d1 create <database-name> --jurisdiction eu` prints the name and
  the id for `[[d1_databases]]`;
- its site ids in `SITES`, and the Access values once [admin access](#admin-access-via-cloudflare-access) is set up;
- `main` and `migrations_dir` pointing back at this repository, relative to the copy's own folder (in `deploy/`:
  `main = "../worker/src/index.ts"`, `migrations_dir = "../migrations"`);
- everything else unchanged: the bindings, the limits, the cron, `workers_dev`, `preview_urls`, `[observability]`.

Every Wrangler command names that copy with `--config`. Deploys are run by hand with a logged-in Wrangler; this repo has
no CI. From the repo root, in this order:

```sh
npm run gate                                                                       # must end GREEN
npx wrangler d1 migrations list <database-name> --remote --config <your-config>    # what is pending (read-only)
npx wrangler d1 migrations apply <database-name> --remote --config <your-config>   # FIRST: the EU database
npx wrangler deploy --config <your-config>                                         # then the Worker
```

- **Migrations first.** Code that meets a missing table drops every record (the insert fails) and the admin page says
  „Keine Daten“. Migrations stay additive.
- Wrangler records each migration by its name relative to `migrations_dir`
  ([D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)), so an applied migration keeps its file
  name.
- **Custom domain.** `wrangler deploy` attaches the host in `routes`. Per Cloudflare's documentation, Cloudflare then
  creates the DNS record and the certificate itself, and a Custom Domain cannot be created on a hostname that already
  has a CNAME record ([Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)).
- A build check without upload: `npx wrangler deploy --dry-run --config <your-config>` (prints the bindings);
  `npx wrangler deploy --dry-run` checks the example config.
- **Check after the deploy.** The answer is always `204`, so a `curl` alone proves nothing (an empty body stores
  nothing and answers `204` too). With observability off, the Worker's warn and log lines exist only in a live tail —
  per Cloudflare's documentation, real-time logs store nothing
  ([Real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/)). So: start
  `npx wrangler tail --ip self --format pretty --config <your-config>` (only your own requests), send ONE valid record,
  see it pass without a warn line, then count it — with the SQL below or in today's row on `/admin`. The record is
  stored like a real decision: today's figures show one more `reject`, kept for three years.

  ```sh
  curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<records-host>/v1/record \
    --data '{"site":"<site-id>","v":1,"a":0,"m":0,"action":"reject","lang":"de"}'
  npx wrangler d1 execute <database-name> --remote --config <your-config> --command \
    "SELECT action, COUNT(*) AS n FROM consent_records WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes') GROUP BY action"
  ```

## Admin access via Cloudflare Access

An operator step. While `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are empty, `/admin` answers `403` to everyone.

The steps below follow Cloudflare's documentation as of 2026-11-13 (linked at each step); they were not checked in
the dashboard, so menu names may differ slightly.

1. **One-time PIN as a login method**, if it is not there yet: Zero Trust › Integrations › Identity providers ›
   Add new identity provider › One-time PIN. New Zero Trust organizations get the Cloudflare identity provider by
   default; one-time PIN is no longer added automatically
   ([One-time PIN login](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)).
2. **The application**: Zero Trust › Access controls › Applications › Create new application › Self-hosted and private
   › Add public hostname — the records host (the one in `routes`) with the path `admin`. An application can protect a
   specific subdomain and path; paths below it inherit its rules
   ([Publish a self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/),
   [Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)).
3. **The policy** (under Access policies, create a new one): action **Allow**; **Include** — selector *Emails* — the
   site operator's e-mail addresses; **Require** — selector *Login Methods* — *One-time PIN*. Never put *Login Methods:
   One-time PIN* alone into the Include rule: per the docs, any e-mail address could then receive a code. Access
   applications deny everyone who matches no Allow policy
   ([Common policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/)).
4. **Authentication**: select *One-time PIN* as the identity provider, then **Create**.
5. **The AUD tag**: Access controls › Applications › the application › Edit › Additional settings › *Application
   Audience (AUD) Tag*. It changes only when the application is deleted or recreated
   ([Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)).
6. **The team domain** is `<team-name>.cloudflareaccess.com`; the team name is shown under Zero Trust › Settings
   ([Cloudflare One setup](https://developers.cloudflare.com/cloudflare-one/setup/)).
7. **Into the deployment's config** `[vars]`, then deploy with its `--config`:

   ```toml
   ACCESS_TEAM_DOMAIN = "<team-name>.cloudflareaccess.com"   # exactly this shape: no https://, no path, no port
   ACCESS_AUD = "<the AUD tag>"
   ```

8. **Check**: open `https://<records-host>/admin` → the Access login → the code arrives by e-mail (per the docs it
   expires 10 minutes after the request) → the page.

**What the Worker checks** (`worker/src/access.ts`), on every `/admin` request, before the database is touched:

1. `ACCESS_AUD` (trimmed) is not empty, and `ACCESS_TEAM_DOMAIN` (trimmed, lower-cased) is
   `<team-name>.cloudflareaccess.com` — one label of letters, digits and inner hyphens on Cloudflare's Access domain;
   no other host, no scheme, path or port. Otherwise `403`, nothing is fetched.
2. The request carries a non-empty `Cf-Access-Jwt-Assertion` header (the header Cloudflare Access adds; the
   `CF_Authorization` cookie is not read). Otherwise `403`.
3. `jwtVerify` (jose) against the team's public keys from `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` (one key
   set per team domain, kept for the isolate's life; jose refetches it once it is older than 10 minutes, or for an
   unknown key id once it is older than 30 seconds) with `algorithms: ["RS256"]`, `audience: ACCESS_AUD`,
   `issuer: https://<ACCESS_TEAM_DOMAIN>` and `requiredClaims: ["exp"]`: the token must be an RS256 token signed with
   one of those keys (an unsigned token, another algorithm or another key fails), `aud` must contain `ACCESS_AUD`,
   `iss` must equal `https://<ACCESS_TEAM_DOMAIN>`, `exp` must be present and in the future, and `nbf` is enforced
   when present.
4. Not checked: the user's e-mail, the token's age (`iat`) — who may sign in is decided by the Access policy alone.

Any failure, a key set that cannot be fetched included (an error answer or a failed request), answers `403 Forbidden`;
the check never throws. Because the Worker verifies the token itself, a request that reaches it around Access (a
deleted or misconfigured application) is refused as well.

## Adding another website

1. **Pick a site id** and add it to `SITES` in the deployment's config (comma-separated, e.g.
   `"example-site,<new-id>"`), then deploy. Records naming an id that is not in `SITES` are dropped.
2. **The built kit**: a Hugo site imports the module ([Use with Hugo](#use-with-hugo)), whose partials emit steps 3
   and 4 and the kit.js tag. Any other site vendors the committed `dist/`: `dist/head.js` and `dist/kit.css` are
   inlined in `<head>`, `dist/kit.js` is served as one same-origin deferred file. The build adds no fingerprint; the
   site's pipeline fingerprints `kit.js`.
3. **`<head>` order**: the site's Google Consent Mode defaults (all denied, no `url_passthrough`) → the config block
   `<script type="application/json" id="ck-config">` → the inline head snippet → the inline CSS.
4. **First in `<body>`**: `kit/templates/banner.html`, rendered in the page language, with
   `data-endpoint="https://<records-host>/v1/record"` and `data-site="<new-id>"` on the first layer. A site with a
   Content Security Policy allows that endpoint in `connect-src`, or the browser blocks the record (the decision still
   stands).
5. **Language and revision**: the kit sends the primary subtag of `<html lang>`, lower-cased (`de-DE` → `de`); the
   service stores `de` and `en` records only — a page in another language, or without `lang`, still decides, its
   records are dropped. The config's `revision` must be an integer from 1 to 1,000,000: the head snippet treats any
   other value as no config (nothing is granted, written or sent, and the first layer is hidden at `load`).
6. **A reopen link** with `data-ck-open` at the bottom of every page — the first-layer text tells visitors to find
   „Cookie-Einstellungen“ / “Cookie settings” there.
7. **The wording**: the strings in `kit/src/i18n/*.json` are samples for a site with an analytics and an advertising
   service — not legal advice. Every site supplies its own legally reviewed texts, rendered into the same keys.

Every attribute, the API, the event and the cookie are described in [kit/README.md](kit/README.md).

## Licence

No licence is granted: all rights reserved. The source is published for reading only. GitHub's Terms of Service still
allow viewing and forking on GitHub; no other use is permitted. Contributions are not accepted.
