/**
 * The records Worker's bindings and vars (wrangler.toml). Every binding is OPTIONAL in the type and
 * DENY by default in code: a missing database drops the record (the prune and the admin page read
 * nothing), a missing rate-limit binding drops the record, an empty `SITES` allows no site, an empty
 * Access config answers 403 on the admin page.
 */
export interface Env {
	/**
	 * The decision records (`consent_records`) — a D1 database created in the EU jurisdiction (migrations
	 * in migrations/).
	 */
	CONSENT_DB?: D1Database;

	// Three Workers Rate Limiting bindings, asked by `POST /v1/record` in this order, stopping at the
	// first refusal (worker/src/record.ts states the trade-off):
	//   CONSENT_ADDR_LIMIT   — 10 per 60 s per client (IPv4 address / IPv6 /64);
	//   CONSENT_PREFIX_LIMIT — 60 per 60 s per IPv6 /48 (IPv6 only);
	//   CONSENT_RATE_LIMIT   — the GLOBAL circuit breaker, 300 per 60 s, one key.
	CONSENT_ADDR_LIMIT?: RateLimit;
	CONSENT_PREFIX_LIMIT?: RateLimit;
	CONSENT_RATE_LIMIT?: RateLimit;

	/** The site ids a record may name, comma-separated (e.g. `example-site`). Empty → no record is stored. */
	SITES?: string;

	/** The Cloudflare Access team domain (`<team>.cloudflareaccess.com`) whose keys sign the admin token. */
	ACCESS_TEAM_DOMAIN?: string;
	/** The Access application's audience (AUD) tag the admin token must carry. */
	ACCESS_AUD?: string;
}

export type HonoEnv = { Bindings: Env };
