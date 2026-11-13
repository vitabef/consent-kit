/**
 * `POST /v1/record` — the consent kit's decision records (contract: worker/src/contract.ts, table:
 * migrations/0001 in `CONSENT_DB`); the site allowlist is the `SITES` var.
 *
 * ALWAYS 204 with no body — for a stored record and for one that is not (invalid, over the cap, no
 * database bound, rate-limited, a binding or D1 failing, anything unexpected): ONE return, so a caller
 * never learns why (the kit sends `mode: "no-cors"` and never reads the answer anyway). The handler
 * never reads a cookie and sets none; failures are logged with `console.warn`, never with the body or
 * the address.
 *
 * TRUST BOUNDARY, stated: the endpoint is public and unauthenticated — every field is client-set,
 * `Origin` is `null` (a site with `Referrer-Policy: no-referrer`), so a record proves that a decision
 * was REPORTED, not by whom. The guards, in the ORDER the route applies them:
 *   1. the bounded body read — at most 512 bytes ever buffered (worker/src/body.ts);
 *   2. a non-empty `SITES` — an EMPTY allowlist is a configuration error: every request is dropped and
 *      logged, one warn line per request until the var is set;
 *   3. the strict validation against that allowlist — junk is dropped before any token is spent and
 *      without a log line (nothing a scanner could flood while `SITES` is set);
 *   4. the database — an absent `CONSENT_DB` drops the record before any token;
 *   5. three Workers Rate Limiting bindings of the records' own (wrangler.toml), asked in this order,
 *      stopping at the first refusal, each per Cloudflare location:
 *        · `CONSENT_ADDR_LIMIT` — 10 per 60 s per client: `consent:<IPv4 address | IPv6 /64>`;
 *        · `CONSENT_PREFIX_LIMIT` — 60 per 60 s per IPv6 /48 (`consent48:…`, IPv6 only): a /48 holder
 *          cannot multiply its budget across its 65,536 /64s, while a carrier /48 shared by many
 *          subscribers is not held to one client's limit;
 *        · `CONSENT_RATE_LIMIT` — the GLOBAL circuit breaker, 300 per 60 s, ONE key — asked LAST, so a
 *          single flooding address or prefix is refused by its own key and never drains the breaker
 *          for everyone else.
 *   Then the prepared INSERT, under `waitUntil` (awaited where there is no execution context).
 *
 * THE TRADE-OFF, stated (an accepted residual risk): the address and
 * prefix keys bound ONE client and ONE network, the breaker bounds EVERYONE. What stays open is a
 * DISTRIBUTED flood (many addresses, many /48s): it writes up to the breaker's cap per location —
 * billed D1 writes, junk rows in the counts of those minutes, kept for the 3 years like real ones (the
 * hourly prune works off up to 5,000 old rows a tick) — and while it lasts, real decisions at that
 * location beyond the cap are dropped. A token spent at an earlier key stays spent when a later key
 * refuses (an address token for a record the breaker then drops): the accepted cost of asking the
 * specific keys first. DENY by default, deliberately: no client address, any of the three bindings
 * missing, or one that throws → the record is dropped — a lost record is a lost statistic, never a lost
 * consent (the visitor's choice lives in the kit's cookie), while a failed brake that let everything
 * through would leave the table unbounded.
 */
import type { Context } from "hono";
import type { HonoEnv } from "./env";
import { readBoundedBody } from "./body";
import { CONSENT_BREAKER_KEY, RECORD_BODY_MAX, allowedSites, consentRateLimitKeys, parseConsentRecord } from "./contract";
import { insertConsentRecord } from "./records-db";

/** Ask a rate-limit binding for one key: `true` = within the limit; a refusal or a throw is `false` (deny by default, the throw logged). */
async function withinLimit(binding: RateLimit, key: string, name: string): Promise<boolean> {
	try {
		return (await binding.limit({ key })).success;
	} catch (err) {
		console.warn(`[consent/record] ${name} binding failed — record dropped (deny by default):`, err instanceof Error ? err.message : err);
		return false;
	}
}

/** Store the decision a request carries when every check passes; drop it otherwise (the route answers the same). */
async function recordDecision(c: Context<HonoEnv>): Promise<void> {
	const raw = await readBoundedBody(c.req.raw, RECORD_BODY_MAX);
	const sites = allowedSites(c.env.SITES);
	if (sites.length === 0) {
		console.warn("[consent/record] SITES is empty — record dropped (deny by default)");
		return;
	}
	const record = parseConsentRecord(raw, sites);
	if (!record) return;
	const db = c.env.CONSENT_DB;
	if (!db) {
		console.warn("[consent/record] CONSENT_DB binding missing — record dropped");
		return;
	}
	const keys = consentRateLimitKeys(c.req.header("CF-Connecting-IP"));
	if (!keys) {
		console.warn("[consent/record] no client address — record dropped (deny by default)");
		return;
	}
	const { CONSENT_ADDR_LIMIT: addressLimit, CONSENT_PREFIX_LIMIT: prefixLimit, CONSENT_RATE_LIMIT: breaker } = c.env;
	if (!addressLimit || !prefixLimit || !breaker) {
		const bindings: Array<[name: string, binding: RateLimit | undefined]> = [
			["CONSENT_ADDR_LIMIT", addressLimit],
			["CONSENT_PREFIX_LIMIT", prefixLimit],
			["CONSENT_RATE_LIMIT", breaker],
		];
		const missing = bindings.filter(([, binding]) => !binding).map(([name]) => name);
		console.warn(`[consent/record] ${missing.join(", ")} binding missing — record dropped (deny by default)`);
		return;
	}
	if (!(await withinLimit(addressLimit, keys.address, "CONSENT_ADDR_LIMIT"))) return;
	if (keys.prefix && !(await withinLimit(prefixLimit, keys.prefix, "CONSENT_PREFIX_LIMIT"))) return;
	if (!(await withinLimit(breaker, CONSENT_BREAKER_KEY, "CONSENT_RATE_LIMIT"))) return;
	const work = insertConsentRecord(db, record);
	try {
		c.executionCtx.waitUntil(work);
	} catch {
		await work;
	}
}

/** The route handler: whatever happens, 204 with no body. */
export async function handleRecord(c: Context<HonoEnv>): Promise<Response> {
	try {
		await recordDecision(c);
	} catch (err) {
		console.warn("[consent/record] unexpected failure — record dropped:", err instanceof Error ? err.message : err);
	}
	return c.body(null, 204);
}
