/**
 * The Worker's surface (worker/src/index.ts): exactly two routes — every other path or method answers
 * 404 — the answer to an error no route catches, and the hourly cron's retention prune
 * (worker/src/scheduled.ts), plus the wrangler.toml facts the deployment rests on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { sqliteD1 } from "./helpers/sqlite-d1";
import worker, { onError } from "../src/index";
import type { HonoEnv } from "../src/env";

const ROOT = resolve(__dirname, "../..");
const MIGRATION = readFileSync(resolve(ROOT, "migrations/0001_consent_records.sql"), "utf8");
const HOST = "https://consent.example.com";
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };

let sqlite: DatabaseSync;

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec(MIGRATION);
});

afterEach(() => {
	try {
		sqlite.close();
	} catch {
		/* already closed */
	}
	vi.restoreAllMocks();
});

describe("routing — POST /v1/record and GET /admin, nothing else", () => {
	it.each([
		["GET", "/"],
		["GET", "/v1/record"],
		["PUT", "/v1/record"],
		["DELETE", "/v1/record"],
		["OPTIONS", "/v1/record"],
		["POST", "/v1/record/"],
		["POST", "/v1/records"],
		["POST", "/consent/v1/record"],
		["POST", "/admin"],
		["GET", "/admin/"],
		["GET", "/admin/consent"],
		["GET", "/robots.txt"],
	])("%s %s → 404, and the database is never touched", async (method, path) => {
		const prepare = vi.fn();
		const res = await worker.fetch(new Request(`${HOST}${path}`, { method }), { CONSENT_DB: { prepare }, SITES: "example-site" } as never, ctx as never);
		expect(res.status).toBe(404);
		expect(prepare).not.toHaveBeenCalled();
		expect(res.headers.get("set-cookie")).toBeNull();
	});
});

describe("an error no route catches — a bare 500, never cached", () => {
	it("on /admin: the admin page's own headers (every admin response carries them), no body; logged without the request", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const exploding = Object.defineProperty({}, "ACCESS_TEAM_DOMAIN", {
			get() {
				throw new Error("binding boom");
			},
		});
		const res = await worker.fetch(new Request(`${HOST}/admin`), exploding as never, ctx as never);
		expect(res.status).toBe(500);
		expect(await res.text()).toBe("");
		expect(Object.fromEntries(res.headers)).toEqual({
			"cache-control": "no-store",
			"x-robots-tag": "noindex, nofollow",
			"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
			"x-content-type-options": "nosniff",
			"referrer-policy": "no-referrer",
		});
		expect(warn.mock.calls).toEqual([["[consent] unexpected failure — 500:", "binding boom"]]);
	});

	it("on any other path: Cache-Control: no-store and nothing else", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const probe = new Hono<HonoEnv>();
		probe.get("/boom", () => {
			throw new Error("boom");
		});
		probe.onError(onError);
		const res = await probe.request(`${HOST}/boom`);
		expect(res.status).toBe(500);
		expect(await res.text()).toBe("");
		expect(Object.fromEntries(res.headers)).toEqual({ "cache-control": "no-store" });
	});
});

describe("the hourly cron — the 3-year retention prune", () => {
	const seed = (createdAt: string) =>
		sqlite
			.prepare("INSERT INTO consent_records (site, revision, analytics, marketing, action, lang, created_at) VALUES ('example-site', 1, 0, 0, 'reject', 'de', ?)")
			.run(createdAt);
	const left = () => (sqlite.prepare("SELECT created_at FROM consent_records ORDER BY created_at").all() as Array<{ created_at: string }>).map((r) => r.created_at);

	it("every tick prunes the records older than 3 years in CONSENT_DB and logs the count", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const recent = new Date(Date.now() - 86_400_000).toISOString();
		seed("2020-01-01T00:00:00.000Z");
		seed(recent);
		await worker.scheduled({ cron: "17 * * * *", scheduledTime: Date.now(), noRetry: () => {} } as never, { CONSENT_DB: sqliteD1(sqlite) } as never, ctx as never);
		expect(left()).toEqual([recent]);
		expect(log.mock.calls.map((c) => String(c[0]))).toEqual(["[cron] consent_records retention: 1 rows older than 3 years pruned"]);
	});

	it("without the binding there is nothing to prune — silent; a throw is logged, never rethrown", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await expect(worker.scheduled({} as never, {} as never, ctx as never)).resolves.toBeUndefined();
		expect(log).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
		const exploding = Object.defineProperty({}, "CONSENT_DB", {
			get() {
				throw new Error("binding boom");
			},
		});
		await expect(worker.scheduled({} as never, exploding as never, ctx as never)).resolves.toBeUndefined();
		expect(warn.mock.calls.map((c) => String(c[0]))).toEqual(["[cron] consent_records retention prune threw:"]);
	});
});

describe("wrangler.toml — the deployment facts", () => {
	const toml = readFileSync(resolve(ROOT, "wrangler.toml"), "utf8");
	const top = toml.split(/\n\[/)[0]!; // the top-level keys, before the first table
	const line = (re: RegExp) => toml.match(re)?.[1];

	it("name, entry, the compatibility date and flags; only the custom domain — no workers.dev, no preview URLs", () => {
		expect(top).toMatch(/^name = "consent-kit"$/m);
		expect(top).toMatch(/^main = "worker\/src\/index\.ts"$/m);
		expect(top).toMatch(/^compatibility_date = "2025-01-01"$/m);
		expect(top).toMatch(/^compatibility_flags = \["nodejs_compat"\]$/m);
		expect(top).toMatch(/^workers_dev = false$/m);
		expect(top).toMatch(/^preview_urls = false$/m);
		expect(top).toMatch(/^routes = \[\{ pattern = "consent\.example\.com", custom_domain = true \}\]$/m);
	});

	it("the hourly cron, the vars (SITES = the one allowed site; Access empty = deny), and no request logs", () => {
		expect(line(/^\[triggers\]\ncrons = (\[.*\])$/m)).toBe('["17 * * * *"]');
		expect(line(/^SITES = "(.*)"$/m)).toBe("example-site");
		expect(line(/^ACCESS_TEAM_DOMAIN = "(.*)"$/m)).toBe("");
		expect(line(/^ACCESS_AUD = "(.*)"$/m)).toBe("");
		expect(toml).toMatch(/^\[observability\]\nenabled = false$/m);
		expect(toml).not.toMatch(/^\[observability\.logs\]/m);
	});
});
