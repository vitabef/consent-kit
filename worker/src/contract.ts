/**
 * The contract of `POST /v1/record` (worker/src/record.ts): what the consent kit sends
 * (kit/src/kit.js `record()`), what the server accepts, and the keys for its three rate-limit
 * bindings.
 *
 * The kit sends `fetch(<data-endpoint>, {method: "POST", body: JSON.stringify({site, v, a, m, action,
 * lang}), keepalive: true, credentials: "omit", mode: "no-cors"})` — a text/plain body, no preflight,
 * no cookies; `Origin` arrives as `null` (a site with `Referrer-Policy: no-referrer`), so the only
 * provenance check is the `site` allowlist (the `SITES` var) — a filter, not a gate (every field is
 * client-set). Validation is STRICT per field: anything outside the contract is no record (the route
 * still answers 204 — it never tells a caller why). Keys beyond the six are ignored, never stored; a
 * duplicated key is judged by its LAST value (`JSON.parse`); the bounded reader decodes with
 * `TextDecoder`, which drops one leading UTF-8 BOM.
 */

/** The route's path. */
export const RECORD_PATH = "/v1/record";

/** The largest body the route READS (worker/src/body.ts); a bigger one is no record. */
export const RECORD_BODY_MAX = 512;

/** The decisions the kit reports: `withdraw` = a granted category was denied. */
export const CONSENT_ACTIONS = ["accept", "reject", "save", "withdraw"] as const;

/** The page languages (`<html lang>`: `de` | `en`). */
const CONSENT_LANGS = ["de", "en"] as const;

/** The highest banner revision accepted (`v`, an integer from 1). */
const CONSENT_REVISION_MAX = 1_000_000;

export type ConsentAction = (typeof CONSENT_ACTIONS)[number];
type ConsentLang = (typeof CONSENT_LANGS)[number];

/** A validated record — exactly what is stored (the server adds the time). */
export interface ConsentRecord {
	/** one of the `SITES` ids */
	site: string;
	revision: number;
	analytics: 0 | 1;
	marketing: 0 | 1;
	action: ConsentAction;
	lang: ConsentLang;
}

/** The site ids the `SITES` var allows: comma-separated, each trimmed, blanks dropped (unset → none). */
export function allowedSites(raw: string | undefined): string[] {
	return (raw ?? "")
		.split(",")
		.map((site) => site.trim())
		.filter((site) => site !== "");
}

/** Is `value` one of the `allowed` strings? (A type guard; anything but a string is no.) */
export function isOneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/** Exactly the number 0 or 1 — never `true`, `"1"` or `1.5` (`-0` is 0: JSON allows it, `===` agrees). */
function isBit(value: unknown): value is 0 | 1 {
	return value === 0 || value === 1;
}

/**
 * The record a body carries, or `null` for anything outside the contract: a missing / over-cap /
 * empty body (`null` or `""` from the bounded reader), malformed JSON, a non-object, a `site` that is
 * not in `sites`, a `v` that is not an integer in 1–{@link CONSENT_REVISION_MAX} (`1e400` parses to
 * Infinity: no), an `a` / `m` other than 0 or 1, an unknown `action`, a `lang` other than `de` / `en`.
 * The categories are stored as the literal 0 / 1 (a `-0` becomes 0).
 */
export function parseConsentRecord(raw: string | null, sites: readonly string[]): ConsentRecord | null {
	if (!raw) return null;
	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
	const { site, v, a, m, action, lang } = body as Record<string, unknown>;
	if (!isOneOf(sites, site)) return null;
	if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > CONSENT_REVISION_MAX) return null;
	if (!isBit(a) || !isBit(m)) return null;
	if (!isOneOf(CONSENT_ACTIONS, action) || !isOneOf(CONSENT_LANGS, lang)) return null;
	return { site, revision: v, analytics: a === 1 ? 1 : 0, marketing: m === 1 ? 1 : 0, action, lang };
}

/**
 * The client address a `CF-Connecting-IP` value names: its FIRST entry (a list keys on its first),
 * trimmed and lower-cased — `""` for a missing or blank header.
 */
export function firstConnectingIp(headerValue: string | null | undefined): string {
	return (headerValue ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
}

/**
 * The unit a per-client brake keys on: an IPv4 address as is; an IPv6 address by its /64 (the first
 * four hextets, `::` expanded, leading zeros and case normalised — a client with a routed /64 cannot
 * rotate out of its bucket); an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) by the embedded IPv4.
 * Never throws on an odd input — it keys on whatever it was given.
 */
export function ipBucket(ip: string): string {
	const raw = ip.trim().toLowerCase();
	if (!raw.includes(":")) return raw;
	const tail = raw.slice(raw.lastIndexOf(":") + 1);
	if (tail.includes(".")) return tail; // IPv4-mapped / compatible
	const [head, rest] = raw.split("::");
	const headGroups = head ? head.split(":") : [];
	const restGroups = rest ? rest.split(":") : [];
	const groups = rest === undefined
		? headGroups
		: [...headGroups, ...Array<string>(Math.max(0, 8 - headGroups.length - restGroups.length)).fill("0"), ...restGroups];
	return groups.slice(0, 4).map((g) => (g === "" ? "0" : g.replace(/^0+(?=.)/, ""))).join(":");
}

/** The keys of one request on the records' own rate-limit bindings (the route asks them in this order). */
interface ConsentRateLimitKeys {
	/** `consent:<address bucket>` on `CONSENT_ADDR_LIMIT` — the IPv4 address, the IPv6 /64. */
	address: string;
	/** `consent48:<first three hextets>` on `CONSENT_PREFIX_LIMIT` — IPv6 only, `null` for IPv4. */
	prefix: string | null;
}

/**
 * A request's keys — from the first entry of the edge-set `CF-Connecting-IP` ({@link firstConnectingIp}),
 * bucketed by {@link ipBucket} (the IPv4 address, the IPv6 /64). Each goes to a binding of its OWN:
 *   · `address` — every request: one client's budget;
 *   · `prefix` — IPv6 only: one holder of a /48 (65,536 /64s) cannot multiply its budget by rotating
 *     through them; the binding allows more than the per-client one, because a carrier's /48 is shared
 *     by many subscribers. An IPv4 address (an IPv4-mapped IPv6 one included — its bucket is the IPv4)
 *     has no prefix key.
 * `null` for a missing or blank header: the route then drops the record (deny by default). A loopback
 * address is keyed like any other (`wrangler dev` injects `127.0.0.1` and enforces the bindings
 * locally: local records share one bucket, which is all a dev needs).
 */
export function consentRateLimitKeys(header: string | null | undefined): ConsentRateLimitKeys | null {
	const first = firstConnectingIp(header);
	if (!first) return null;
	const bucket = ipBucket(first);
	return {
		address: `consent:${bucket}`,
		prefix: bucket.includes(":") ? `consent48:${bucket.split(":").slice(0, 3).join(":")}` : null,
	};
}

/** The ONE key of the global circuit breaker (`CONSENT_RATE_LIMIT`, asked last). */
export const CONSENT_BREAKER_KEY = "consent:all";
