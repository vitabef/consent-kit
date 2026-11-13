/**
 * `GET /admin` (worker/src/admin.tsx + worker/src/access.ts) through the REAL Worker: the Cloudflare
 * Access gate — deny by default for an empty or malformed config, a missing token and every invalid
 * token, with the team's key set MOCKED (a `fetch` stub serving a JWKS of a key pair made here) — and
 * the standalone page: the 30 Berlin days with their counts and shares, the 30-day totals, the three
 * states without figures, escaped output and its headers. The database is the real migration in an
 * in-memory SQLite; the clock is fixed (only `Date` is faked) so the Berlin days are reproducible.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SignJWT, UnsecuredJWT, exportJWK, generateKeyPair } from "jose";
import { sqliteD1 } from "./helpers/sqlite-d1";
import worker from "../src/index";
import { ACCESS_JWT_HEADER } from "../src/access";

const MIGRATION = readFileSync(resolve(__dirname, "../../migrations/0001_consent_records.sql"), "utf8");
const NOW = new Date("2026-11-12T10:00:00.000Z"); // Berlin: Thursday, 11:00 (winter time)
const AUD = "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2";
const KID = "kid-1";

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let keys: KeyPair;
let otherKeys: KeyPair;
/** An ES256 key pair whose public key IS in the team's key set: only the algorithm sets its tokens apart. */
let ecKeys: KeyPair;
let jwks: { keys: unknown[] };
let sqlite: DatabaseSync;
let fetchSpy: ReturnType<typeof vi.fn>;
let teamCounter = 0;
/** A fresh team domain per test: the Worker caches one key set per team for the isolate's life. */
let team: string;

beforeAll(async () => {
	keys = await generateKeyPair("RS256", { extractable: true });
	otherKeys = await generateKeyPair("RS256", { extractable: true });
	ecKeys = await generateKeyPair("ES256", { extractable: true });
	jwks = {
		keys: [
			{ ...(await exportJWK(keys.publicKey)), kid: KID, alg: "RS256", use: "sig" },
			{ ...(await exportJWK(ecKeys.publicKey)), kid: "kid-ec", alg: "ES256", use: "sig" },
		],
	};
});

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec(MIGRATION);
	team = `team-${++teamCounter}.cloudflareaccess.com`;
	fetchSpy = vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200, headers: { "Content-Type": "application/json" } }));
	vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	try {
		sqlite.close();
	} catch {
		/* already closed */
	}
});

/** A token as Cloudflare Access issues it, signed with `signer` (default: the team's key); `expiresIn: null` = no `exp`. */
async function accessToken(
	opts: { aud?: string; iss?: string; alg?: string; signer?: CryptoKey; kid?: string; expiresIn?: string | null; issuedAgo?: number; notBefore?: string } = {},
): Promise<string> {
	const issuedAt = Math.floor(NOW.getTime() / 1000) - (opts.issuedAgo ?? 0);
	const jwt = new SignJWT({ email: "admin@example.test", type: "app" })
		.setProtectedHeader({ alg: opts.alg ?? "RS256", kid: opts.kid ?? KID })
		.setAudience([opts.aud ?? AUD])
		.setIssuer(opts.iss ?? `https://${team}`)
		.setSubject("user-1")
		.setIssuedAt(issuedAt);
	if (opts.expiresIn !== null) jwt.setExpirationTime(opts.expiresIn ?? issuedAt + 300);
	if (opts.notBefore !== undefined) jwt.setNotBefore(opts.notBefore);
	return jwt.sign(opts.signer ?? keys.privateKey);
}

/** `null` = no CONSENT_DB binding at all. */
function env(overrides: Record<string, unknown> = {}, consentDb: D1Database | null = sqliteD1(sqlite)): Record<string, unknown> {
	return { SITES: "example-site", ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: AUD, ...(consentDb ? { CONSENT_DB: consentDb } : {}), ...overrides };
}

async function getAdmin(e: Record<string, unknown>, token?: string, method = "GET"): Promise<Response> {
	const headers: Record<string, string> = token === undefined ? {} : { [ACCESS_JWT_HEADER]: token };
	return worker.fetch(new Request("https://consent.example.com/admin", { method, headers }), e as never, { waitUntil: () => {}, passThroughOnException: () => {} } as never);
}

/** A database that must never be read. */
function untouchedDb() {
	const prepare = vi.fn(() => {
		throw new Error("must not be read");
	});
	return { db: { prepare } as unknown as D1Database, prepare };
}

function seed(createdAt: string, action: string, analytics: number, marketing: number): void {
	sqlite
		.prepare("INSERT INTO consent_records (site, revision, analytics, marketing, action, lang, created_at) VALUES ('example-site', 1, ?, ?, ?, 'de', ?)")
		.run(analytics, marketing, action, createdAt);
}

/** The text of every cell of the day row `day` (tags stripped). */
function dayCells(html: string, day: string): string[] {
	const start = html.indexOf(`data-consent-day="${day}"`);
	expect(start, `row for ${day}`).toBeGreaterThan(-1);
	const row = html.slice(start, html.indexOf("</tr>", start));
	return [...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, "").trim());
}

async function expectForbidden(res: Response): Promise<void> {
	expect(res.status).toBe(403);
	expect(await res.text()).toBe("Forbidden");
	expect(res.headers.get("cache-control")).toBe("no-store");
	expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
}

describe("GET /admin — the Cloudflare Access gate (deny by default)", () => {
	it("a valid Access token: 200 — its key set fetched from https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs, once per isolate", async () => {
		const res = await getAdmin(env(), await accessToken());
		expect(res.status).toBe(200);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toBe(`https://${team}/cdn-cgi/access/certs`);
		expect((await getAdmin(env(), await accessToken())).status).toBe(200);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it.each([
		["ACCESS_TEAM_DOMAIN and ACCESS_AUD empty", { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" }],
		["ACCESS_AUD empty", { ACCESS_AUD: "" }],
		["ACCESS_AUD only blanks", { ACCESS_AUD: "   " }],
		["ACCESS_TEAM_DOMAIN empty", { ACCESS_TEAM_DOMAIN: "" }],
		["both unset", { ACCESS_TEAM_DOMAIN: undefined, ACCESS_AUD: undefined }],
		["ACCESS_TEAM_DOMAIN with a scheme", { ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com" }],
		["ACCESS_TEAM_DOMAIN with a path", { ACCESS_TEAM_DOMAIN: "evil.example/x#" }],
		["ACCESS_TEAM_DOMAIN without a dot", { ACCESS_TEAM_DOMAIN: "localhost" }],
		["ACCESS_TEAM_DOMAIN on another host", { ACCESS_TEAM_DOMAIN: "team.example.com" }],
		["ACCESS_TEAM_DOMAIN on another host that starts like a team domain", { ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com.evil.example" }],
		["ACCESS_TEAM_DOMAIN on a look-alike host", { ACCESS_TEAM_DOMAIN: "evilcloudflareaccess.com" }],
		["ACCESS_TEAM_DOMAIN without a team name", { ACCESS_TEAM_DOMAIN: "cloudflareaccess.com" }],
	])("empty or malformed config (%s): 403 even with a valid token — no key set fetched, the database never read", async (_label, overrides) => {
		const db = untouchedDb();
		await expectForbidden(await getAdmin(env(overrides, db.db), await accessToken()));
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(db.prepare).not.toHaveBeenCalled();
	});

	it("an upper-case or padded ACCESS_TEAM_DOMAIN names the same team: 200 — the keys fetched from the lower-cased host", async () => {
		const res = await getAdmin(env({ ACCESS_TEAM_DOMAIN: `  ${team.toUpperCase()} ` }), await accessToken());
		expect(res.status).toBe(200);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toBe(`https://${team}/cdn-cgi/access/certs`);
	});

	it("no Cf-Access-Jwt-Assertion header (a request around Access): 403 — no key set fetched, the database never read; an empty header too", async () => {
		expect(ACCESS_JWT_HEADER).toBe("Cf-Access-Jwt-Assertion");
		const db = untouchedDb();
		await expectForbidden(await getAdmin(env({}, db.db)));
		await expectForbidden(await getAdmin(env({}, db.db), ""));
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(db.prepare).not.toHaveBeenCalled();
	});

	it.each([
		["signed with another key (same key id)", () => accessToken({ signer: otherKeys.privateKey })],
		["an unknown key id", () => accessToken({ kid: "kid-unknown", signer: otherKeys.privateKey })],
		["another audience", () => accessToken({ aud: "another-application" })],
		["another issuer (iss is not https://<ACCESS_TEAM_DOMAIN>)", () => accessToken({ iss: "https://another-team.cloudflareaccess.com" })],
		["expired", () => accessToken({ issuedAgo: 600, expiresIn: "-1m" })],
		["not valid yet (nbf in the future)", () => accessToken({ notBefore: "5m" })],
		["no expiry (no exp claim)", () => accessToken({ expiresIn: null })],
		["another algorithm (ES256 — its key IS in the team's set)", () => accessToken({ alg: "ES256", kid: "kid-ec", signer: ecKeys.privateKey })],
		["not a JWT", async () => "not-a-jwt"],
		["unsigned (alg none)", async () => new UnsecuredJWT({ email: "admin@example.test" }).setAudience(AUD).setIssuer(`https://${team}`).setIssuedAt().setExpirationTime("5m").encode()],
	])("an invalid token (%s): 403, the database never read", async (_label, make) => {
		const db = untouchedDb();
		await expectForbidden(await getAdmin(env({}, db.db), await make()));
		expect(db.prepare).not.toHaveBeenCalled();
	});

	it("a key set that cannot be fetched (the certs endpoint failing): 403", async () => {
		fetchSpy.mockImplementation(async () => new Response("down", { status: 500 }));
		await expectForbidden(await getAdmin(env(), await accessToken()));
		expect(fetchSpy).toHaveBeenCalled();
	});

	it("a key set whose fetch rejects (a network failure): 403", async () => {
		fetchSpy.mockImplementation(async () => {
			throw new TypeError("network down");
		});
		await expectForbidden(await getAdmin(env(), await accessToken()));
		expect(fetchSpy).toHaveBeenCalled();
	});

	it("HEAD /admin goes through the same gate (Hono answers HEAD with the GET route): 403 without a token", async () => {
		const res = await getAdmin(env(), undefined, "HEAD");
		expect(res.status).toBe(403);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("GET /admin — the page", () => {
	it("renders the 30 Berlin days (today first) with the counts per action, the shares and the totals", async () => {
		seed("2026-11-12T09:30:00.000Z", "accept", 1, 1);
		seed("2026-11-12T08:00:00.000Z", "reject", 0, 0);
		seed("2026-11-11T23:30:00.000Z", "save", 1, 0); // Berlin 00:30 on 11-12
		seed("2026-11-10T12:00:00.000Z", "withdraw", 0, 1);
		seed("2026-09-01T12:00:00.000Z", "accept", 1, 1); // outside the 30 days
		const res = await getAdmin(env(), await accessToken());
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html.startsWith("<!doctype html><html lang=\"de\">")).toBe(true);
		expect(html).toContain("<title>Einwilligungen — Consent-Kit</title>");
		expect(html.match(/data-consent-day="/g)).toHaveLength(30);
		expect(html.indexOf('data-consent-day="2026-11-12"')).toBeLessThan(html.indexOf('data-consent-day="2026-10-14"'));
		// Tag · Akzeptiert · Abgelehnt · Auswahl gespeichert · Widerrufen · Gesamt · Statistik erlaubt · Marketing erlaubt
		const today = dayCells(html, "2026-11-12");
		expect(today.slice(0, 6)).toEqual(["Do., 12.11.2026", "1", "1", "1", "0", "3"]);
		expect(today[6]).toMatch(/^67\s%$/);
		expect(today[7]).toMatch(/^33\s%$/);
		expect(dayCells(html, "2026-11-10").slice(1)).toEqual(["0", "0", "0", "1", "1", expect.stringMatching(/^0\s%$/), expect.stringMatching(/^100\s%$/)]);
		expect(dayCells(html, "2026-11-11").slice(1)).toEqual(["0", "0", "0", "0", "0", "—", "—"]);
		// The 30-day totals (the September record counts nowhere).
		const kpi = (label: string) => {
			const at = html.indexOf(`<dt>${label}</dt>`);
			expect(at, label).toBeGreaterThan(-1);
			return html.slice(at, html.indexOf("</div>", at)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
		};
		expect(kpi("Entscheidungen")).toBe("Entscheidungen 4");
		expect(kpi("Akzeptiert")).toBe("Akzeptiert 1");
		expect(kpi("Widerrufen")).toBe("Widerrufen 1");
		expect(kpi("Statistik erlaubt")).toMatch(/^Statistik erlaubt 50\s% 2 von 4$/);
		expect(kpi("Marketing erlaubt")).toMatch(/^Marketing erlaubt 50\s% 2 von 4$/);
		// The legend: a withdrawal record carries the visitor's NEW choice, which the shares include.
		expect(html).toContain("der Eintrag trägt die neue Wahl des Besuchers");
		expect(html).toContain("die neue Wahl aus Widerrufen eingeschlossen");
		expect(html).toContain("(Site-IDs: example-site)");
	});

	it("never cached, never indexed, no script allowed, never framed — a standalone page (no script, no external asset)", async () => {
		const res = await getAdmin(env(), await accessToken());
		expect(res.headers.get("content-type")).toMatch(/^text\/html/);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
		expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("referrer-policy")).toBe("no-referrer");
		expect(res.headers.get("set-cookie")).toBeNull();
		const html = await res.text();
		expect(html).toContain('<meta name="robots" content="noindex, nofollow"/>');
		expect(html).not.toMatch(/<script|<link|<img|<form|src=/);
	});

	it("escapes what it shows: a SITES value with markup is text, never markup", async () => {
		const html = await (await getAdmin(env({ SITES: 'example-site,<img src=x onerror="alert(1)">' }), await accessToken())).text();
		expect(html).toContain("(Site-IDs: example-site, &lt;img src=x onerror=&quot;alert(1)&quot;&gt;)");
		expect(html).not.toContain("<img");
	});

	it("SITES empty: the page says that nothing is stored", async () => {
		const html = await (await getAdmin(env({ SITES: "" }), await accessToken())).text();
		expect(html).toContain("Variable <code>SITES</code> ist leer, es wird nichts gespeichert");
	});

	it("without the CONSENT_DB binding: „Keine Daten“ (200), never a 500", async () => {
		const res = await getAdmin(env({}, null), await accessToken());
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('data-consent-gap="no-database"');
		expect(html).toContain("Keine Daten.");
		expect(html).toContain("<code>CONSENT_DB</code>");
		expect(html).not.toContain("data-consent-day=");
	});

	it("before the migration ran (no table): „Keine Daten“ with the migration named", async () => {
		const empty = new DatabaseSync(":memory:");
		try {
			const html = await (await getAdmin(env({}, sqliteD1(empty)), await accessToken())).text();
			expect(html).toContain('data-consent-gap="table-missing"');
			expect(html).toContain("<code>migrations/0001</code>");
		} finally {
			empty.close();
		}
	});

	it("a failed read: the error notice (200), logged", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const broken = {
			prepare: () => {
				throw new Error("D1_ERROR: unreachable");
			},
		} as unknown as D1Database;
		const res = await getAdmin(env({}, broken), await accessToken());
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('data-consent-gap="read-failed"');
		expect(html).toContain("Fehler beim Laden der Einwilligungen");
		expect(warn).toHaveBeenCalled();
	});
});
