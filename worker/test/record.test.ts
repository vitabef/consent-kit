/**
 * `POST /v1/record` (worker/src/record.ts), driven through the REAL Worker (worker/src/index.ts)
 * against the REAL migration in an in-memory SQLite (node:sqlite behind the D1 slice the route uses).
 * The contract under test is the route's module doc: ALWAYS
 * 204 with no body; a row only for a valid record of an allowed site (`SITES`), with the server's
 * time; the records' three brakes in order — CONSENT_ADDR_LIMIT (`consent:<address>`),
 * CONSENT_PREFIX_LIMIT (`consent48:<IPv6 /48>`), CONSENT_RATE_LIMIT (one global key); deny by default.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sqliteD1 } from "./helpers/sqlite-d1";
import worker, { app } from "../src/index";

const ROOT = resolve(__dirname, "../..");
const MIGRATION = readFileSync(resolve(ROOT, "migrations/0001_consent_records.sql"), "utf8");
const URL_RECORD = "https://consent.example.com/v1/record";
const BREAKER_KEY = "consent:all";
/** U+FEFF, built at runtime: an invisible literal in the source would be one an editor can strip. */
const BOM = String.fromCharCode(0xfeff);

/** What the kit sends (kit/src/kit.js `record()`): JSON.stringify({site, v, a, m, action, lang}). */
const VALID = { site: "example-site", v: 1, a: 1, m: 0, action: "save", lang: "de" };
const body = (fields: Record<string, unknown>): string => JSON.stringify(fields);

/** A Workers Rate Limiting double: refuses the keys listed in `refuse`, records every key asked. */
function createRateLimit(refuse: string[] = [], opts: { throws?: boolean } = {}) {
	const asked: string[] = [];
	return {
		limit: vi.fn(async ({ key }: { key: string }) => {
			asked.push(key);
			if (opts.throws) throw new Error("binding down");
			return { success: !refuse.includes(key) };
		}),
		asked,
	};
}
type RateLimitDouble = ReturnType<typeof createRateLimit>;

let sqlite: DatabaseSync;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec(MIGRATION);
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	try {
		sqlite.close();
	} catch {
		/* already closed */
	}
	vi.restoreAllMocks();
});

const rows = () =>
	sqlite.prepare("SELECT site, revision, analytics, marketing, action, lang, created_at FROM consent_records ORDER BY id").all() as Array<Record<string, unknown>>;
const warnings = () => warn.mock.calls.map((c: unknown[]) => String(c[0]));

interface HarnessOpts {
	/** CONSENT_ADDR_LIMIT; `null` = no binding at all. */
	addr?: RateLimitDouble | null;
	/** CONSENT_PREFIX_LIMIT; `null` = no binding at all. */
	prefix?: RateLimitDouble | null;
	/** CONSENT_RATE_LIMIT (the global breaker); `null` = no binding at all. */
	breaker?: RateLimitDouble | null;
	/** `false` = no CONSENT_DB binding; a custom double replaces the SQLite one. */
	consentDb?: D1Database | false;
	/** The SITES var; `null` = unset (default: the wrangler.toml value). */
	sites?: string | null;
}

function harness(opts: HarnessOpts = {}) {
	const pending: Promise<unknown>[] = [];
	const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} };
	const pick = (o: RateLimitDouble | null | undefined) => (o === undefined ? createRateLimit() : o);
	const addr = pick(opts.addr);
	const prefix = pick(opts.prefix);
	const breaker = pick(opts.breaker);
	const env: Record<string, unknown> = {};
	if (opts.sites !== null) env.SITES = opts.sites ?? "example-site";
	if (opts.consentDb !== false) env.CONSENT_DB = opts.consentDb ?? sqliteD1(sqlite);
	if (addr) env.CONSENT_ADDR_LIMIT = addr;
	if (prefix) env.CONSENT_PREFIX_LIMIT = prefix;
	if (breaker) env.CONSENT_RATE_LIMIT = breaker;
	const send = async (payload: string, headers: Record<string, string> = {}) => {
		const req = new Request(URL_RECORD, {
			method: "POST",
			body: payload,
			// The kit's no-cors fetch: a string body is text/plain; the site's Referrer-Policy makes Origin `null`.
			headers: { "Content-Type": "text/plain;charset=UTF-8", Origin: "null", "CF-Connecting-IP": "203.0.113.7", ...headers },
		});
		const res = await worker.fetch(req, env as never, ctx as never);
		await Promise.all(pending);
		return res;
	};
	/** Every key asked on the three bindings. */
	const tokens = () => [...(addr?.asked ?? []), ...(prefix?.asked ?? []), ...(breaker?.asked ?? [])];
	return { send, pending, addr, prefix, breaker, tokens, env };
}

/** A D1 double whose every statement throws — and which records that it was asked. */
function brokenD1() {
	const prepare = vi.fn(() => {
		throw new Error("D1_ERROR: unreachable");
	});
	return { db: { prepare } as unknown as D1Database, prepare };
}

describe("POST /v1/record — a valid record", () => {
	it("answers 204 with no body and stores ONE row: the six fields as sent, the server's time; the insert runs under waitUntil", async () => {
		const h = harness();
		const before = Date.now();
		const res = await h.send(body(VALID));
		const after = Date.now();
		expect(res.status).toBe(204);
		expect(await res.text()).toBe("");
		expect(h.pending).toHaveLength(1);
		const stored = rows();
		expect(stored).toHaveLength(1);
		const row = stored[0]!;
		expect(row).toMatchObject({ site: "example-site", revision: 1, analytics: 1, marketing: 0, action: "save", lang: "de" });
		expect(String(row.created_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		const at = Date.parse(String(row.created_at));
		expect(at).toBeGreaterThanOrEqual(before);
		expect(at).toBeLessThanOrEqual(after);
	});

	it("stores every action in both languages, and the revision bound's both ends (1 and 1,000,000)", async () => {
		const h = harness();
		for (const action of ["accept", "reject", "save", "withdraw"]) {
			for (const lang of ["de", "en"]) {
				expect((await h.send(body({ ...VALID, action, lang }))).status).toBe(204);
			}
		}
		expect((await h.send(body({ ...VALID, v: 1_000_000, a: 0, m: 1 }))).status).toBe(204);
		const stored = rows();
		expect(stored.map((r) => `${r.action}/${r.lang}`)).toEqual([
			"accept/de", "accept/en", "reject/de", "reject/en", "save/de", "save/en", "withdraw/de", "withdraw/en", "save/de",
		]);
		expect(stored[8]).toMatchObject({ revision: 1_000_000, analytics: 0, marketing: 1 });
	});

	it("keys beyond the six are ignored, never stored; a body of exactly 512 bytes is still read", async () => {
		const h = harness();
		const padded = { ...VALID, pad: "" };
		padded.pad = "x".repeat(512 - Buffer.byteLength(body(padded)));
		expect(Buffer.byteLength(body(padded))).toBe(512);
		expect((await h.send(body(padded))).status).toBe(204);
		const stored = rows();
		expect(stored).toHaveLength(1);
		const { created_at: _at, ...fields } = stored[0]!;
		expect(fields).toEqual({ site: "example-site", revision: 1, analytics: 1, marketing: 0, action: "save", lang: "de" });
	});

	it("never sets a cookie — even when the request carries one", async () => {
		const res = await harness().send(body(VALID), { Cookie: "admin_session=abc; _ga=GA1.1.1" });
		expect(res.status).toBe(204);
		expect(res.headers.get("set-cookie")).toBeNull();
		expect(rows()).toHaveLength(1);
	});
});

describe("POST /v1/record — the site allowlist is the SITES var", () => {
	it("a site in SITES is stored; any other site is no record (204, no row, no token, nothing logged)", async () => {
		const h = harness();
		expect((await h.send(body({ ...VALID, site: "another-site" }))).status).toBe(204);
		expect((await h.send(body({ ...VALID, site: "example-site " }))).status).toBe(204);
		expect(rows()).toEqual([]);
		expect(h.tokens()).toEqual([]);
		expect(warn).not.toHaveBeenCalled();
		await h.send(body(VALID));
		expect(rows().map((r) => r.site)).toEqual(["example-site"]);
	});

	it("several sites, comma-separated with blanks around them, are each allowed; an empty entry allows nothing", async () => {
		const h = harness({ sites: " example-site , other-site ,," });
		await h.send(body(VALID));
		await h.send(body({ ...VALID, site: "other-site" }));
		await h.send(body({ ...VALID, site: "" }));
		expect(rows().map((r) => r.site)).toEqual(["example-site", "other-site"]);
	});

	for (const [label, sites] of [
		["unset", null],
		["empty", ""],
		["only blanks and commas", " , ,"],
	] as const) {
		it(`SITES ${label}: no record at all, before any token is spent — logged as a configuration error`, async () => {
			const h = harness({ sites });
			expect((await h.send(body(VALID))).status).toBe(204);
			expect(rows()).toEqual([]);
			expect(h.tokens()).toEqual([]);
			expect(warnings()).toEqual(["[consent/record] SITES is empty — record dropped (deny by default)"]);
		});
	}
});

describe("POST /v1/record — anything outside the contract is no record (204, no row, no token)", () => {
	const over512 = (() => {
		const padded = { ...VALID, pad: "" };
		padded.pad = "x".repeat(513 - Buffer.byteLength(body(padded)));
		return body(padded);
	})();
	// Under 512 CHARACTERS but over 512 BYTES — the cap is in bytes.
	const over512Bytes = (() => {
		const padded = { ...VALID, pad: "" };
		padded.pad = "ä".repeat(Math.ceil((513 - Buffer.byteLength(body(padded))) / 2));
		return body(padded);
	})();
	const CASES: Array<[label: string, payload: string]> = [
		["unknown site", body({ ...VALID, site: "evil.example" })],
		["site missing", body({ v: 1, a: 1, m: 0, action: "save", lang: "de" })],
		["v = 0", body({ ...VALID, v: 0 })],
		["v negative", body({ ...VALID, v: -1 })],
		["v fractional", body({ ...VALID, v: 1.5 })],
		["v as a string", body({ ...VALID, v: "1" })],
		["v over 1,000,000", body({ ...VALID, v: 1_000_001 })],
		["v missing", body({ site: "example-site", a: 1, m: 0, action: "save", lang: "de" })],
		["a = 2", body({ ...VALID, a: 2 })],
		["a as a string", body({ ...VALID, a: "1" })],
		["a as a boolean", body({ ...VALID, a: true })],
		["m = -1", body({ ...VALID, m: -1 })],
		["m missing", body({ site: "example-site", v: 1, a: 1, action: "save", lang: "de" })],
		["unknown action", body({ ...VALID, action: "accept_all" })],
		["action in capitals", body({ ...VALID, action: "ACCEPT" })],
		["unknown lang", body({ ...VALID, lang: "fr" })],
		["lang with a region", body({ ...VALID, lang: "de-DE" })],
		["lang in capitals", body({ ...VALID, lang: "DE" })],
		["malformed JSON", '{"site":"example-site",'],
		["form-encoded, not JSON", "site=example-site&v=1&a=1&m=0&action=save&lang=de"],
		["JSON null", "null"],
		["a JSON array", body([VALID] as unknown as Record<string, unknown>)],
		["a JSON number", "1"],
		["over 512 bytes", over512],
		["over 512 bytes in UTF-8 (fewer characters)", over512Bytes],
		["empty body", ""],
	];

	it("each case answers 204 with no body, stores nothing and spends no token on any binding", async () => {
		expect(Buffer.byteLength(over512)).toBe(513);
		expect(over512Bytes.length).toBeLessThanOrEqual(512);
		expect(Buffer.byteLength(over512Bytes)).toBeGreaterThan(512);
		const h = harness();
		for (const [label, payload] of CASES) {
			const res = await h.send(payload);
			expect(res.status, label).toBe(204);
			expect(await res.text(), label).toBe("");
		}
		expect(rows()).toEqual([]);
		expect(h.tokens()).toEqual([]);
		expect(h.pending).toEqual([]);
		// Junk is dropped silently: nothing logged per request (no log line a scanner could flood).
		expect(warn).not.toHaveBeenCalled();
	});
});

describe("POST /v1/record — JSON edge cases", () => {
	const RAW = (fields: string) => `{${fields}}`;
	const REST = '"action":"reject","lang":"de"';

	it("`-0` is the number 0: accepted, stored as the literal 0 (never a negative zero)", async () => {
		const h = harness();
		expect((await h.send(RAW(`"site":"example-site","v":1,"a":-0,"m":-0,${REST}`))).status).toBe(204);
		const [row] = rows();
		expect(Object.is(row!.analytics, 0)).toBe(true);
		expect(Object.is(row!.marketing, 0)).toBe(true);
		// …and a `-0` revision is below 1: no record.
		expect((await h.send(RAW(`"site":"example-site","v":-0,"a":0,"m":0,${REST}`))).status).toBe(204);
		expect(rows()).toHaveLength(1);
	});

	it("a UTF-8 BOM before the JSON is dropped by the decoder (TextDecoder) — the record counts; a second BOM is malformed JSON", async () => {
		const h = harness();
		expect((await h.send(`${BOM}${body(VALID)}`)).status).toBe(204);
		expect(rows()).toHaveLength(1);
		expect((await h.send(`${BOM}${BOM}${body(VALID)}`)).status).toBe(204);
		expect(rows()).toHaveLength(1);
	});

	it("a duplicated key is judged by its LAST value (JSON.parse) — and that value is validated like any other", async () => {
		const h = harness();
		expect((await h.send(RAW(`"site":"example-site","site":"evil.example","v":1,"a":0,"m":0,${REST}`))).status).toBe(204);
		expect((await h.send(RAW(`"site":"example-site","v":1,"a":0,"a":2,"m":0,${REST}`))).status).toBe(204);
		expect(rows()).toEqual([]);
		expect((await h.send(RAW(`"site":"evil.example","site":"example-site","v":1,"a":2,"a":1,"m":0,${REST}`))).status).toBe(204);
		expect(rows()).toHaveLength(1);
		expect(rows()[0]).toMatchObject({ site: "example-site", analytics: 1 });
	});

	it("`1e400` parses to Infinity — no integer, no bit: no record; an exponent that IS an integer (`1e2` = 100) is a revision like any other", async () => {
		const h = harness();
		expect((await h.send(RAW(`"site":"example-site","v":1e400,"a":0,"m":0,${REST}`))).status).toBe(204);
		expect((await h.send(RAW(`"site":"example-site","v":1,"a":1e400,"m":0,${REST}`))).status).toBe(204);
		expect(rows()).toEqual([]);
		expect((await h.send(RAW(`"site":"example-site","v":1e2,"a":0,"m":0,${REST}`))).status).toBe(204);
		expect(rows()).toHaveLength(1);
		expect(rows()[0]).toMatchObject({ revision: 100 });
	});
});

describe("POST /v1/record — the 512-byte cap is a bounded read (never buffered, never 413)", () => {
	const CHUNK = 16 * 1024;

	/** A body handed out lazily in CHUNK pieces (highWaterMark 0: nothing moves until a reader asks), counting what it delivered. */
	function trackedRequest(bytes: number, opts: { chunked?: boolean; declared?: string } = {}) {
		const data = new Uint8Array(bytes).fill(0x61);
		let offset = 0;
		let pulls = 0;
		const stream = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					pulls++;
					if (offset >= data.byteLength) {
						controller.close();
						return;
					}
					const end = Math.min(offset + CHUNK, data.byteLength);
					controller.enqueue(data.slice(offset, end));
					offset = end;
				},
			},
			{ highWaterMark: 0 },
		);
		const headers = new Headers({ "Content-Type": "text/plain;charset=UTF-8", "CF-Connecting-IP": "203.0.113.7" });
		if (!opts.chunked) headers.set("Content-Length", opts.declared ?? String(bytes));
		const req = new Request(URL_RECORD, { method: "POST", headers, body: stream, duplex: "half" } as RequestInit);
		return {
			req,
			get pulls() {
				return pulls;
			},
			get delivered() {
				return offset;
			},
		};
	}

	it("an oversized record answers 204 — a declared length is never read, a chunked body is abandoned after the first chunk, an unparseable length too", async () => {
		const h = harness();
		for (const opts of [{ chunked: false }, { chunked: true }, { chunked: false, declared: "abc" }]) {
			const t = trackedRequest(4 * CHUNK, opts);
			const res = await worker.fetch(t.req, h.env as never, { waitUntil: () => {}, passThroughOnException: () => {} } as never);
			expect(res.status, JSON.stringify(opts)).toBe(204);
			expect(await res.text()).toBe("");
			expect(t.delivered, JSON.stringify(opts)).toBe(opts.chunked || opts.declared ? CHUNK : 0);
			if (!opts.chunked && !opts.declared) expect(t.pulls).toBe(0);
		}
		expect(rows()).toEqual([]);
		expect(h.tokens()).toEqual([]);
	});
});

describe("POST /v1/record — the records' own brakes: address → prefix (IPv6) → global", () => {
	it("the limits live in wrangler.toml, each binding its own namespace (1001–1003 in the example), with their limits and periods", () => {
		const toml = readFileSync(resolve(ROOT, "wrangler.toml"), "utf8");
		const limits = Object.fromEntries(
			toml
				.split("[[ratelimits]]")
				.slice(1)
				.map((block) => {
					const field = (key: string) => block.match(new RegExp(`^\\s*${key} = "?([^"\\n]*)"?$`, "m"))?.[1];
					return [field("name"), { namespace: field("namespace_id"), limit: Number(field("limit")), period: Number(field("period")) }];
				}),
		);
		expect(limits).toEqual({
			CONSENT_ADDR_LIMIT: { namespace: "1001", limit: 10, period: 60 },
			CONSENT_PREFIX_LIMIT: { namespace: "1002", limit: 60, period: 60 },
			CONSENT_RATE_LIMIT: { namespace: "1003", limit: 300, period: 60 },
		});
	});

	it("per client: CONSENT_ADDR_LIMIT with `consent:<IPv4 address | IPv6 /64>` (a list keys on its first entry); IPv6 also asks CONSENT_PREFIX_LIMIT with its /48", async () => {
		const h = harness();
		await h.send(body(VALID));
		await h.send(body(VALID), { "CF-Connecting-IP": "2001:db8:abcd:12:1:2:3:4" });
		await h.send(body(VALID), { "CF-Connecting-IP": "203.0.113.9, 10.0.0.1" });
		await h.send(body(VALID), { "CF-Connecting-IP": "::ffff:198.51.100.4" }); // IPv4-mapped: the IPv4, no prefix key
		expect(rows()).toHaveLength(4);
		expect(h.addr!.asked).toEqual(["consent:203.0.113.7", "consent:2001:db8:abcd:12", "consent:203.0.113.9", "consent:198.51.100.4"]);
		expect(h.prefix!.asked).toEqual(["consent48:2001:db8:abcd"]);
		expect(h.breaker!.asked).toEqual([BREAKER_KEY, BREAKER_KEY, BREAKER_KEY, BREAKER_KEY]);
	});

	it("the order is address → prefix → global, stopping at the first refusal", async () => {
		const h = harness();
		await h.send(body(VALID), { "CF-Connecting-IP": "2001:db8:abcd:12::1" });
		const [a] = h.addr!.limit.mock.invocationCallOrder;
		const [p] = h.prefix!.limit.mock.invocationCallOrder;
		const [g] = h.breaker!.limit.mock.invocationCallOrder;
		expect(a!).toBeLessThan(p!);
		expect(p!).toBeLessThan(g!);
		// A refused address asks neither the prefix nor the breaker.
		const r = harness({ addr: createRateLimit(["consent:2001:db8:abcd:12"]) });
		await r.send(body(VALID), { "CF-Connecting-IP": "2001:db8:abcd:12::1" });
		expect(r.prefix!.asked).toEqual([]);
		expect(r.breaker!.asked).toEqual([]);
		expect(rows()).toHaveLength(1); // only the first harness's record
	});

	it("per IPv6 /48: a refused /48 drops a record from ANY /64 inside it — and never reaches the breaker; another /48 passes", async () => {
		const h = harness({ prefix: createRateLimit(["consent48:2001:db8:abcd"]) });
		await h.send(body(VALID), { "CF-Connecting-IP": "2001:db8:abcd:12::1" });
		await h.send(body(VALID), { "CF-Connecting-IP": "2001:db8:abcd:ffff::1" });
		expect(rows()).toEqual([]);
		expect(h.breaker!.asked).toEqual([]);
		await h.send(body(VALID), { "CF-Connecting-IP": "2001:db8:abce::1" });
		expect(rows()).toHaveLength(1);
		expect(h.prefix!.asked).toEqual(["consent48:2001:db8:abcd", "consent48:2001:db8:abcd", "consent48:2001:db8:abce"]);
	});

	it("the breaker is ONE global key, asked last: a refusal drops the record (204, no row) — the address token already spent is the accepted cost", async () => {
		const h = harness({ breaker: createRateLimit([BREAKER_KEY]) });
		expect((await h.send(body(VALID))).status).toBe(204);
		expect(rows()).toEqual([]);
		expect(h.addr!.asked).toEqual(["consent:203.0.113.7"]);
		expect(h.breaker!.asked).toEqual([BREAKER_KEY]);
	});

	it("a single flooding address never drains the breaker: refused by its own key, it never reaches the global one", async () => {
		const h = harness({ addr: createRateLimit(["consent:203.0.113.7"]) });
		for (let i = 0; i < 5; i++) await h.send(body(VALID));
		expect(rows()).toEqual([]);
		expect(h.breaker!.asked).toEqual([]);
		await h.send(body(VALID), { "CF-Connecting-IP": "198.51.100.4" });
		expect(h.breaker!.asked).toEqual([BREAKER_KEY]);
		expect(rows()).toHaveLength(1);
	});
});

describe("POST /v1/record — deny by default (204, no row)", () => {
	for (const missing of ["CONSENT_ADDR_LIMIT", "CONSENT_PREFIX_LIMIT", "CONSENT_RATE_LIMIT"] as const) {
		it(`${missing} missing: the record is dropped before any token is spent — even for an IPv4 client that would not ask it — and the drop is logged`, async () => {
			const h = harness({
				addr: missing === "CONSENT_ADDR_LIMIT" ? null : undefined,
				prefix: missing === "CONSENT_PREFIX_LIMIT" ? null : undefined,
				breaker: missing === "CONSENT_RATE_LIMIT" ? null : undefined,
			});
			expect((await h.send(body(VALID))).status).toBe(204);
			expect(rows()).toEqual([]);
			expect(h.tokens()).toEqual([]);
			expect(warnings()).toContain(`[consent/record] ${missing} binding missing — record dropped (deny by default)`);
		});
	}

	it("all three missing: one warning naming each", async () => {
		const h = harness({ addr: null, prefix: null, breaker: null });
		expect((await h.send(body(VALID))).status).toBe(204);
		expect(warnings()).toContain("[consent/record] CONSENT_ADDR_LIMIT, CONSENT_PREFIX_LIMIT, CONSENT_RATE_LIMIT binding missing — record dropped (deny by default)");
	});

	it("a binding that throws — any of the three — drops the record", async () => {
		const ipv6 = { "CF-Connecting-IP": "2001:db8:abcd:12::1" };
		for (const which of ["addr", "prefix", "breaker"] as const) {
			const h = harness({ [which]: createRateLimit([], { throws: true }) });
			expect((await h.send(body(VALID), ipv6)).status, which).toBe(204);
		}
		expect(rows()).toEqual([]);
		for (const name of ["CONSENT_ADDR_LIMIT", "CONSENT_PREFIX_LIMIT", "CONSENT_RATE_LIMIT"]) {
			expect(warnings()).toContain(`[consent/record] ${name} binding failed — record dropped (deny by default):`);
		}
	});

	it("no client address (no CF-Connecting-IP): dropped without asking any binding — there is no address to key on", async () => {
		const h = harness();
		const req = new Request(URL_RECORD, { method: "POST", body: body(VALID), headers: { "Content-Type": "text/plain;charset=UTF-8" } });
		const res = await worker.fetch(req, h.env as never, { waitUntil: () => {}, passThroughOnException: () => {} } as never);
		expect(res.status).toBe(204);
		expect(rows()).toEqual([]);
		expect(h.tokens()).toEqual([]);
		expect(warnings()).toContain("[consent/record] no client address — record dropped (deny by default)");
	});

	it("no CONSENT_DB binding: dropped before any token is spent", async () => {
		const h = harness({ consentDb: false });
		expect((await h.send(body(VALID))).status).toBe(204);
		expect(h.tokens()).toEqual([]);
		expect(h.pending).toEqual([]);
		expect(warnings()).toContain("[consent/record] CONSENT_DB binding missing — record dropped");
	});

	it("a failing insert: still 204; the warning carries neither the record nor the address", async () => {
		const broken = brokenD1();
		const h = harness({ consentDb: broken.db });
		expect((await h.send(body(VALID))).status).toBe(204);
		expect(broken.prepare).toHaveBeenCalledTimes(1);
		const logged = JSON.stringify(warn.mock.calls);
		expect(logged).toContain("[consent-records] insert failed");
		expect(logged).not.toContain("example-site");
		expect(logged).not.toContain("203.0.113.7");
	});
});

describe("POST /v1/record — cookies, execution context, the unexpected", () => {
	const bindings = () => ({
		SITES: "example-site",
		CONSENT_DB: sqliteD1(sqlite),
		CONSENT_ADDR_LIMIT: createRateLimit(),
		CONSENT_PREFIX_LIMIT: createRateLimit(),
		CONSENT_RATE_LIMIT: createRateLimit(),
	});

	it("never reads the Cookie header: no header lookup asks for it, the headers are never iterated", async () => {
		const req = new Request(URL_RECORD, {
			method: "POST",
			body: body(VALID),
			headers: { Cookie: "admin_session=abc", "CF-Connecting-IP": "203.0.113.7", "Content-Type": "text/plain;charset=UTF-8" },
		});
		const headers = req.headers;
		const looked: string[] = [];
		const realGet = headers.get.bind(headers);
		const realHas = headers.has.bind(headers);
		vi.spyOn(headers, "get").mockImplementation((name: string) => {
			looked.push(name.toLowerCase());
			return realGet(name);
		});
		vi.spyOn(headers, "has").mockImplementation((name: string) => {
			looked.push(name.toLowerCase());
			return realHas(name);
		});
		const iterations = [vi.spyOn(headers, "forEach"), vi.spyOn(headers, "entries"), vi.spyOn(headers, "keys"), vi.spyOn(headers, "values"), vi.spyOn(headers, Symbol.iterator)];
		const res = await app.request(req, undefined, bindings());
		expect(res.status).toBe(204);
		expect(res.headers.get("set-cookie")).toBeNull();
		expect(rows()).toHaveLength(1); // the handler ran its whole path
		expect(looked).toContain("cf-connecting-ip");
		expect(looked).not.toContain("cookie");
		for (const spy of iterations) expect(spy).not.toHaveBeenCalled();
	});

	it("a runtime without an execution context still answers 204 — the insert is awaited instead of scheduled", async () => {
		const res = await app.request(URL_RECORD, { method: "POST", body: body(VALID), headers: { "CF-Connecting-IP": "203.0.113.7" } }, bindings());
		expect(res.status).toBe(204);
		expect(rows()).toHaveLength(1);
	});

	it("anything unexpected (here: no env at all) is still a 204, never a 500", async () => {
		const res = await app.request(URL_RECORD, { method: "POST", body: body(VALID), headers: { "CF-Connecting-IP": "203.0.113.7" } });
		expect(res.status).toBe(204);
		expect(await res.text()).toBe("");
		expect(warnings()).toContain("[consent/record] unexpected failure — record dropped:");
	});
});
