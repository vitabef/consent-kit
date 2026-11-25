# The stored choice, read on a server

Specification version 1 · test vectors: [`vectors.json`](vectors.json), version 1

The kit keeps a visitor's consent decision in one first-party cookie, and its inline head snippet
(`kit/src/head.js`) reads that cookie on every page. This document says how a server-side helper — PHP, Node, any
language — reads the same cookie from a request's `Cookie` header and reaches the same answer, or a stricter one where
it cannot read what the browser may: raw bytes that are not UTF-8 (§ 3), a limit of its JSON parser (§ 4) — there a
copy denies both categories. The head snippet is the reference: where this text and `head.js` disagree, `head.js` is right. [`vectors.json`](vectors.json) pins the
rules: a helper conforms when it passes every vector, and `kit/test/cookie-vectors.test.ts` runs the shipped head
snippet over the same vectors.

The kit writes exactly `encodeURIComponent(JSON.stringify({v, a, m, t}))` with `Max-Age=15552000; Path=/;
SameSite=Lax` (and `Secure` on https) — [kit/README.md, The stored choice](../kit/README.md#the-stored-choice). Every
rule beyond that shape exists because other writers (an older kit, another tool, a hand-edited cookie) and other
paths to the server (a proxy, a client that is not a browser) exist: the head snippet accepts or rejects what they
produce in fixed ways, and a helper must do the same.

## Inputs

**The config.** The `cookie` and `revision` that the page's config block
(`<script type="application/json" id="ck-config">`) carries — from the same source, so that a revision bump reaches
the pages and the server together. The config is valid only when:

- `cookie` is a non-empty string, and
- `revision` is a number with an integer value from 1 to 1,000,000. In JSON, `2` and `2.0` are the same number
  (§ 5); a string such as `"2"`, a boolean, `null` or a fraction is not a valid revision.

Anything else is **no config**: the verdict is undecided, whatever the request carries — the head snippet then
grants, writes and sends nothing either. A site keeps `cookie` to letters, digits, `_`, `.` and `-` (the Hugo and the
HTML adapter enforce that); the rules below hold for any name.

**The request.** Its `Cookie` header: absent, or one value. A request with several `Cookie` field lines (HTTP/2 and
HTTP/3 allow that) is read as their values joined by `"; "` in their order — RFC 9113 §8.2.3; most servers join them
that way already. Never join them with a comma.

## The algorithm

```text
verdict(config, header):
  if config is not valid: return UNDECIDED
  copies = []
  for each piece of header split at ";":              # § 1
    remove spaces and tabs at both ends of piece
    if piece does not start with cookie + "=": next    # § 2
    text = strict-percent-decode(rest of piece)        # § 3, a failure: next — but raw bytes
                                                       #   that are not UTF-8: add {a: 0, m: 0}, next
    o = parse-strict-json(text)                        # § 4, a failure: next — but one for a limit
                                                       #   of the parser (§ 4): add {a: 0, m: 0}, next
    if o is a valid choice: add o to copies            # § 5
  if copies is empty: return UNDECIDED                 # § 6
  return { decided: true,
           analytics: every copy has a = 1,
           marketing: every copy has m = 1 }

UNDECIDED = { decided: false, analytics: false, marketing: false }
```

A copy that fails a step is skipped: it neither counts nor denies — except one with raw bytes that are not UTF-8
(§ 3) or one that a server's parser refuses for a limit of its own (§ 4), which denies. No step throws, and no failure ever grants.

### 1. Pieces

Split the header at every `;` (U+003B). Remove spaces (U+0020) and horizontal tabs (U+0009) at both ends of each
piece; an empty piece is skipped. Nothing else separates: a `,` stays inside the piece it is in (a header whose lines
were joined with commas loses the choice that follows a comma), and no other whitespace is removed.

Why this is `head.js`: a browser writes both `document.cookie` and the `Cookie` header as `name=value` pairs joined
by `"; "`, and no name or value it stores holds a `;` or starts or ends with a space or a tab — so the head snippet's
split at `"; "` and this split give the same pieces. A header that reaches the server in another form (no space after
`;`, more spaces or a tab, an empty piece, a trailing `;`) carries the same cookies, and this split recovers them.

### 2. Copies

A piece is a **copy** of the stored choice when it starts with the configured name followed directly by `=`,
compared byte for byte, case-sensitive. Its value is everything after that `=`, unchanged — a later `=` included.

- `ck_consent_old=…`, `xck_consent=…`, `CK_CONSENT=…` and `ck_consent =…` (a space before `=`) are no copies of
  `ck_consent`.
- A piece without `=` (a cookie without a name) is no copy — `ck_consent` alone included.
- Every piece that matches is a copy. A request carries several when the browser holds several cookies of that name
  (a host-only and a `Domain=` copy, one with another `Path`). There is no "first wins" or "last wins": § 6 combines
  them.

### 3. Decoding the value

The head snippet decodes the value with `decodeURIComponent`. The server equivalent, on the value's bytes:

1. Every `%` must be followed by two hexadecimal digits (`0-9`, `A-F`, `a-f`); the three characters become the byte
   they name. A `%` without two hex digits after it makes the copy malformed.
2. Every other byte stays as it is. **A `+` stays a `+`**: it is not a space.
3. The resulting bytes must be valid UTF-8 (RFC 3629: no overlong form, no surrogate U+D800–U+DFFF, nothing above
   U+10FFFF), else the copy is malformed. They are the JSON text, a leading byte order mark included: it is a
   character like any other, not something to drop.

For every value a browser can send, this is exactly `decodeURIComponent`: a raw non-ASCII character in the value
reaches the server as its UTF-8 bytes. **Raw bytes that are not UTF-8** — not `%`-escaped; only another writer stores
them — make the copy one that denies both categories, whatever the steps above find, and it is never skipped: the
head snippet reads them through `document.cookie`, a string the browser builds from them, so the server cannot tell
whether that copy counts there, and skipping it would drop its denial from the minimum (§ 6) and let another copy
grant. A server that gets the header as a latin1 string (Node: one character per byte) checks the bytes it stands
for. An escaped sequence that is not UTF-8 (`%FF`) stays malformed: `decodeURIComponent` throws on it, and the head
snippet skips that copy too. No vector pins raw bytes that are not UTF-8: a JSON file holds text, not bytes.

### 4. Parsing the JSON

Parse the text as strict JSON (RFC 8259 — what `JSON.parse` accepts). Whitespace (space, tab, LF, CR) around tokens
is allowed; nothing else that a lenient parser takes: no trailing comma, no single quotes, no comments, no leading
zero (`01`), no `NaN` or `Infinity` literal — in any member, an ignored one included — and no byte order mark. A
member that occurs more than once counts with its last value. A result that is a string is never parsed a second
time. Text that is not JSON makes the copy malformed.

**A limit of the parser.** Some JSON parsers refuse text that `JSON.parse` reads: an escaped unpaired surrogate
(`"\ud800"`), a nesting deeper than they read. A copy that a server's parser refuses for such a limit of its own counts
as a copy that denies both categories, and is never skipped: skipping it would drop its denial from the minimum (§ 6)
and let another copy grant what the browser denies. That holds even when the text has an error after that point,
which a parser that stopped there cannot see. This only ever denies more than the browser: the verdict may read
decided with both categories denied where the head snippet reads undecided or grants — never the other way.

### 5. A valid choice

The parsed value must be a JSON object — not an array, a string, a number, `true`, `false` or `null` — whose members
named exactly `v`, `a`, `m` and `t` are:

| Member | Rule |
|---|---|
| `v` | a number equal to the config's `revision` |
| `a` | a number equal to 0 or 1: analytics denied or granted |
| `m` | a number equal to 0 or 1: marketing denied or granted |
| `t` | a positive integer of at most 2^53 − 1 (9,007,199,254,740,991): the time of the decision in unix seconds, not checked any further |

Other members are ignored, whatever they hold. A missing member fails the copy. The bound on `t` keeps it among the
integers every JSON parser reads alike: past 2^53 − 1 a double rounds while a 64-bit or a big integer stays exact,
and some parsers refuse a number beyond binary64 (`1e400`), so the same cookie would read differently on different
servers.

**Numbers.** Only a JSON number is a number: `"1"` is a string and `true` a boolean, and neither is 1 (the head
snippet checks `typeof` and compares with `===`). A number is read as the IEEE 754 binary64 value nearest to it,
ties to even — what `JSON.parse` does:

- `2`, `2.0`, `2e0`, `20e-1` and `2.0000000000000001` are all the number 2; `1`, `1.0` and `1E0` are 1; `0`, `0.0`
  and `-0` are 0;
- a number too large for binary64 (`1e400`) is +Infinity, and one too small (`1e-400`) is 0: neither is a valid `t`,
  and +Infinity is valid in no member.

### 6. Several copies: the most restrictive counts

With one valid copy or more, the visitor is **decided**, and a category is granted only when **every** valid copy
grants it: each category's minimum over the copies. Two copies granting and denying both deny both; crossed copies
(`a: 1, m: 0` and `a: 0, m: 1`) deny both too — the result can be stricter than every single copy. Malformed copies
and copies of another revision take no part; a copy with raw bytes that are not UTF-8 (§ 3) or refused for a limit of
the server's parser (§ 4) takes part, denying both. Without a valid copy the visitor is **undecided**.

## The verdict

`{ decided, analytics, marketing }`, three booleans:

| Situation | `decided` | `analytics` | `marketing` |
|---|---|---|---|
| no valid config | `false` | `false` | `false` |
| no valid copy, and none that denies (§§ 3, 4) | `false` | `false` | `false` |
| one valid copy or more, or one that denies (§§ 3, 4) | `true` | every such copy has `a: 1` | every such copy has `m: 1` |

Undecided denies every category: **fail-closed**. The verdict is the head snippet's `consentKit.get()` without
`revision`, in a browser without Global Privacy Control — except for a copy that the server cannot read (§§ 3, 4):
it denies there, so the verdict may be decided and stricter than `get()`, never more permissive.

The server reads the copies the request carries. They are the page's own, except in two cases: the cookie is
`SameSite=Lax`, so a cross-site request other than a top-level `GET` navigation (a form `POST` from another site, a
frame on another site) carries none and reads undecided — fail-closed; and a request can carry a copy the page
cannot read — an `HttpOnly` one, or one whose `Path` leaves the page out — which only another writer can have set
(the kit writes from script, with `Path=/`).

## What a server may do with it

- **Gate what it controls.** Set an optional cookie of its own, add a server-side tag or measurement call, render an
  embed — for a category only while the verdict grants it. Undecided is denied.
- **Clean up a denied category**, undecided included, as the kit does on every page load — with a valid config only:
  without one the kit does nothing at all, and the server cleans up nothing either. For every cookie in
  the request whose name — the piece up to its first `=`, the whole piece when it has none — matches a pattern of
  the config's `cleanup.<category>.cookies` (an exact name, or a prefix ending in `*`), send the kit's deletions
  (`drop()` in `kit/src/kit.js`), each as a `Set-Cookie` field of its own:

  ```http
  Set-Cookie: <name>=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/
  Set-Cookie: <name>=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Domain=<domain>
  Set-Cookie: <name>=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Domain=<hostname>
  ```

  The first deletes the host-only cookie. The second is sent only when the config has a `domain`; the third only
  when the page's hostname is not that `domain` (always, without one). `<hostname>` is the host the page is served
  on, without a port — the server's own name for it, never an unchecked `Host` header. Not covered, as in the kit:
  a copy with another `Path`, and one on an intermediate parent domain. Nor can this form delete a cookie whose name
  starts with `__Secure-` or `__Host-` (a browser takes those only with `Secure`, a `__Host-` one also without
  `Domain`), nor, on a page served over plain http, any `Secure` cookie — limits the kit's own deletions share.
  `cleanup.<category>.localStorage` is the browser's: the kit removes those keys.

  Clean up only on a request that would carry the choice cookie if the visitor had one: an https request — the kit
  writes the cookie `Secure` on https, so a plain-http request to the same site goes without it while it still
  carries the tag cookies — and not a cross-site request other than a top-level `GET` navigation (Fetch Metadata:
  `Sec-Fetch-Site: cross-site`, unless the method is `GET` with `Sec-Fetch-Mode: navigate` and
  `Sec-Fetch-Dest: document`). Either verdict is undecided because the cookie was withheld, not because the visitor
  denied. A site served on plain http only (a test host) gets no server cleanup: the kit's own cleanup still runs.
- **Delete `legacy` cookies** (a previous consent tool's) the same way, on any response — the kit does it on every
  page load.

A response whose content or `Set-Cookie` fields depend on the verdict belongs to one visitor: keep shared caches from
storing it (`Cache-Control: private`, or `no-store`).

## What a server must not do

- **Grant on anything but a valid copy**: not while undecided, not with an invalid config, not on `Sec-GPC`, a login,
  a query parameter or a previous tool's cookie.
- **Write the choice cookie** — set, refresh or delete any cookie of the configured name. The kit is its only
  writer: every decision there sends a consent record (a server write records nothing), and a copy that the head
  snippet cannot read (`HttpOnly`) or reads on other pages only (another `Path`) makes the two readers disagree.
- **Change the kit's page parts by the verdict.** The config block, the head snippet, the first layer and the
  settings dialog go into every page, decided or not: the head snippet hides the first layer itself, and the reopen
  link needs the dialog. Gated tags in the page stay `type="text/plain"` for the kit to activate: the browser's state
  can differ from the request's (a decision in another tab since then, a cached page).

## Global Privacy Control

A browser with Global Privacy Control (`navigator.globalPrivacyControl === true`; it sends `Sec-GPC: 1`) and no valid
stored choice is a reject to the kit: decided, both categories denied, no first layer, no cookie written
([kit/README.md, Global Privacy Control](../kit/README.md#global-privacy-control)). The verdict has no GPC input: for
that visitor it is undecided, both categories denied — the same outcome, so a server needs no GPC handling. `decided`
is the one difference (`consentKit.get()` reads `true`, the verdict `false`), and neither grants anything. A valid
stored choice wins over GPC in the kit, so the verdict is that stored choice, `Sec-GPC` or not.

## Traps

The usual ways a helper misses these rules — each one is pinned by a vector:

- **Cookie maps.** `$_COOKIE` in PHP and the parsed cookies of most server frameworks and cookie libraries keep one
  value per name, and many decode values on their own terms: `+` as a space, quotes stripped, the raw text kept when
  decoding fails. PHP also turns a `.` in a name into `_` (spaces too). Parse the raw `Cookie` header.
- **Matching the name.** Compare it as a literal prefix: a regular expression built from it reads its `.` as any
  character, so `ck.consent` would match `ckxconsent`.
- **Trimming.** Remove only spaces and tabs at the ends of a piece: PHP's `trim()`, Python's `strip()` and
  JavaScript's `trim()` remove more — a vertical tab, for one — and a name behind it would then match.
- **Percent-decoding.** PHP: `rawurldecode()`, never `urldecode()`, which turns `+` into a space — and
  `rawurldecode()` neither rejects a bad `%` escape nor checks UTF-8: check both yourself. Python:
  `urllib.parse.unquote(value, errors="strict")` — the default `errors="replace"` turns invalid UTF-8 into U+FFFD —
  never `unquote_plus()`; `unquote()` keeps a bad `%` escape as text: check it yourself. JavaScript:
  `decodeURIComponent()`, never a form decoder such as `URLSearchParams`. A UTF-8 decoder must keep a leading byte
  order mark: `TextDecoder` needs `ignoreBOM: true`, Python's `utf-8-sig` drops it.
- **Numbers.** PHP's `json_decode()` returns `2.0` as a float: compare by value after `is_int() || is_float()`,
  never with `===` against an integer, and never by a loose comparison alone (`"1" == 1`, `true == 1`, `in_array()`
  without its strict flag). Python: `True == 1` and `True in (0, 1)` — exclude booleans first; `json.loads()`
  accepts `NaN` and `Infinity` unless `parse_constant` rejects them. A parser that refuses a number beyond binary64
  (`1e400`) gives the right answer for `v`, `a`, `m` and `t`, which accept none; in another member, which the head
  snippet ignores, it must not fail the copy: decode only the four members, skipping the others unconverted.
- **Parser limits.** PHP's `json_decode()` stops at depth 512 by default, and one vector nests 600 levels: pass a
  larger depth. Past that depth (a 4,096-byte cookie value can nest about 2,000 levels) and at an escaped unpaired
  surrogate it refuses the text (`JSON_ERROR_DEPTH`, `JSON_ERROR_UTF16`): count that copy as denying (§ 4), never
  skip it. A parser that keeps the first of a repeated member, or rejects the object,
  reads differently: the last one counts. A lenient parser takes what `JSON.parse` rejects: comments, a leading zero,
  `NaN`.
- **The prototype (JavaScript).** Read the members of the parsed object as they are: copying it into another object
  with `Object.assign()` makes a `"__proto__"` member the prototype, whose `v`, `a`, `m` and `t` would then count.

## The test vectors

[`vectors.json`](vectors.json):

```json
{
  "version": 1,
  "spec": "spec/consent-cookie.md",
  "about": "…",
  "vectors": [
    {
      "name": "what the case pins",
      "config": { "cookie": "ck_consent", "revision": 2 },
      "cookieHeader": "ck_consent=%7B%22v%22%3A2%2C%22a%22%3A1%2C%22m%22%3A0%2C%22t%22%3A1700000000%7D",
      "expected": { "decided": true, "analytics": true, "marketing": false }
    }
  ]
}
```

- `config` is the site config; some vectors give an invalid one, which a helper must treat as no config.
  `cookieHeader` is the `Cookie` header's value as the helper receives it, `null` for a request without one.
  `expected` is the verdict.
- A helper passes when its verdict equals `expected` for every vector. `version` rises when an expectation or the
  format changes; new vectors may come without it.
- The reference run, `kit/test/cookie-vectors.test.ts`: the head snippet as built runs once per vector, with the
  vector's config block and a `document.cookie` made from `cookieHeader` — `""` for `null`, otherwise the header
  split at every `;`, spaces and tabs at both ends of each piece removed, empty pieces dropped, the rest joined by
  `"; "` (§ 1). The vectors carry no `HttpOnly` cookie and no GPC.
