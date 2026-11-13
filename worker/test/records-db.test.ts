/**
 * The `consent_records` data layer (worker/src/records-db.ts) against the REAL migration in an
 * in-memory SQLite (node:sqlite): the migration's CHECKs and covering index, the D1 binding in
 * wrangler.toml, the insert, the 3-year retention prune and the admin page's Berlin-day counts (DST
 * included) — aggregated in SQL and answered from the index alone (EXPLAIN QUERY PLAN of the module's
 * OWN statements).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { CONSENT_STATS_DAYS, insertConsentRecord, pruneConsentRecords, readConsentStats } from "../src/records-db";
import type { ConsentRecord } from "../src/contract";

const ROOT = resolve(__dirname, "../..");
const MIGRATION = readFileSync(resolve(ROOT, "migrations/0001_consent_records.sql"), "utf8");
const RECORD: ConsentRecord = { site: "example-site", revision: 2, analytics: 1, marketing: 0, action: "save", lang: "en" };

let sqlite: DatabaseSync;
let db: D1Database;

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec(MIGRATION);
	db = sqliteD1(sqlite);
});

afterEach(() => {
	try {
		sqlite.close();
	} catch {
		/* already closed */
	}
	vi.restoreAllMocks();
});

function seed(createdAt: string, action = "accept", analytics = 1, marketing = 1): void {
	sqlite
		.prepare("INSERT INTO consent_records (site, revision, analytics, marketing, action, lang, created_at) VALUES ('example-site', 1, ?, ?, ?, 'de', ?)")
		.run(analytics, marketing, action, createdAt);
}

const createdAts = () => (sqlite.prepare("SELECT created_at FROM consent_records ORDER BY created_at").all() as Array<{ created_at: string }>).map((r) => r.created_at);

/** A D1 double whose every statement throws. */
const brokenD1 = (message = "D1_ERROR: unreachable") =>
	({
		prepare: () => {
			throw new Error(message);
		},
	}) as unknown as D1Database;

/** The SQLite D1 slice, recording every statement the module binds (to EXPLAIN its OWN SQL). */
function recordingD1(target: DatabaseSync) {
	const inner = sqliteD1(target);
	const bound: Array<{ sql: string; args: unknown[] }> = [];
	const recording = {
		prepare(sql: string) {
			const stmt = inner.prepare(sql);
			return {
				bind(...args: unknown[]) {
					bound.push({ sql, args });
					return stmt.bind(...args);
				},
			};
		},
	} as unknown as D1Database;
	return { db: recording, bound };
}

/** The `detail` lines of SQLite's query plan for `sql` with its bound arguments. */
const queryPlan = (sql: string, args: unknown[]): string[] =>
	(sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])) as Array<{ detail: string }>).map((r) => r.detail);

describe("consent_records — the migration and the binding", () => {
	it("migrations/0001 creates the table and its covering index; it is the only migration (the file name already applied to the database)", () => {
		expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS consent_records\b/);
		expect(MIGRATION).toMatch(/CREATE INDEX IF NOT EXISTS idx_consent_records_created_at\s+ON consent_records \(created_at, action, analytics, marketing\)/);
		expect(readdirSync(resolve(ROOT, "migrations"))).toEqual(["0001_consent_records.sql"]);
	});

	it("wrangler.toml binds CONSENT_DB — and only it — to the example database `consent-records` (a placeholder id, migrations/)", () => {
		const toml = readFileSync(resolve(ROOT, "wrangler.toml"), "utf8");
		const blocks = toml.split("[[d1_databases]]").slice(1).map((b) => b.split(/\n\[/)[0]!);
		expect(blocks).toHaveLength(1);
		const field = (key: string) => blocks[0]!.match(new RegExp(`^${key} = "([^"]*)"$`, "m"))?.[1];
		expect(field("binding")).toBe("CONSENT_DB");
		expect(field("database_name")).toBe("consent-records");
		expect(field("database_id")).toBe("00000000-0000-0000-0000-000000000000");
		expect(field("migrations_dir")).toBe("migrations");
	});

	it("the migration's CHECKs refuse out-of-contract rows — a second line behind the route's validation", () => {
		const insert = (analytics: unknown, marketing: unknown, action: unknown) =>
			sqlite
				.prepare("INSERT INTO consent_records (site, revision, analytics, marketing, action, lang, created_at) VALUES ('example-site', 1, ?, ?, ?, 'de', '2026-11-12T10:00:00.000Z')")
				.run(analytics as never, marketing as never, action as never);
		expect(() => insert(2, 0, "accept")).toThrow(/CHECK constraint failed/);
		expect(() => insert(0, -1, "accept")).toThrow(/CHECK constraint failed/);
		expect(() => insert(1, 1, "maybe")).toThrow(/CHECK constraint failed/);
		expect(() => insert(null, 1, "accept")).toThrow(/NOT NULL constraint failed/);
		expect(() => insert(1, 0, "withdraw")).not.toThrow();
	});
});

describe("insertConsentRecord", () => {
	it("stores the record with the given server time in the ISO shape", async () => {
		const now = new Date("2026-11-12T10:15:30.250Z");
		await expect(insertConsentRecord(db, RECORD, now)).resolves.toBe(true);
		expect(sqlite.prepare("SELECT site, revision, analytics, marketing, action, lang, created_at FROM consent_records").all()).toEqual([
			{ site: "example-site", revision: 2, analytics: 1, marketing: 0, action: "save", lang: "en", created_at: "2026-11-12T10:15:30.250Z" },
		]);
	});

	it("never throws: a D1 failure is `false`, logged without the record", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await expect(insertConsentRecord(brokenD1(), RECORD)).resolves.toBe(false);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(warn.mock.calls)).not.toContain("example-site");
	});
});

describe("pruneConsentRecords — 3-year retention", () => {
	const NOW = new Date("2026-11-12T10:00:00.000Z"); // the cutoff: 2023-11-12T10:00:00.000Z

	it("deletes ONLY rows older than 3 calendar years — the row exactly at the cutoff and everything newer stay; idempotent", async () => {
		seed("2021-01-01T00:00:00.000Z");
		seed("2023-11-12T09:59:59.999Z"); // one millisecond past the window
		seed("2023-11-12T10:00:00.000Z"); // exactly 3 years: kept
		seed("2023-11-13T00:00:00.000Z");
		seed("2026-11-12T09:00:00.000Z");
		await expect(pruneConsentRecords(db, { now: NOW })).resolves.toBe(2);
		expect(createdAts()).toEqual(["2023-11-12T10:00:00.000Z", "2023-11-13T00:00:00.000Z", "2026-11-12T09:00:00.000Z"]);
		await expect(pruneConsentRecords(db, { now: NOW })).resolves.toBe(0);
	});

	it("is bounded per call — the oldest go first — and clamps the batch option", async () => {
		seed("2020-01-03T00:00:00.000Z");
		seed("2020-01-01T00:00:00.000Z");
		seed("2020-01-02T00:00:00.000Z");
		await expect(pruneConsentRecords(db, { now: NOW, batchSize: 2 })).resolves.toBe(2);
		expect(createdAts()).toEqual(["2020-01-03T00:00:00.000Z"]);
		await expect(pruneConsentRecords(db, { now: NOW, batchSize: Number.NaN })).resolves.toBe(1); // NaN → the default batch
	});

	it("works off up to 5,000 rows per call (the hourly tick) — the default AND the ceiling of the batch option", async () => {
		const seedOld = (n: number) =>
			sqlite.exec(`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ${n})
				INSERT INTO consent_records (site, revision, analytics, marketing, action, lang, created_at)
				SELECT 'example-site', 1, 0, 0, 'reject', 'de', '2020-01-01T00:00:00.000Z' FROM k`);
		seedOld(5_001);
		await expect(pruneConsentRecords(db, { now: NOW })).resolves.toBe(5_000);
		await expect(pruneConsentRecords(db, { now: NOW })).resolves.toBe(1);
		seedOld(5_001);
		await expect(pruneConsentRecords(db, { now: NOW, batchSize: 10_000 })).resolves.toBe(5_000);
	});

	it("finds its rows through the covering index (EXPLAIN QUERY PLAN of the prune's own statement)", async () => {
		const rec = recordingD1(sqlite);
		await pruneConsentRecords(rec.db, { now: NOW });
		expect(rec.bound).toHaveLength(1);
		const plan = queryPlan(rec.bound[0]!.sql, rec.bound[0]!.args);
		expect(plan.some((d) => /USING COVERING INDEX idx_consent_records_created_at \(created_at<\?\)/.test(d)), plan.join(" | ")).toBe(true);
	});

	it("without a database there is nothing to prune (0, silent); a D1 failure is 0 and logged, never thrown", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await expect(pruneConsentRecords(undefined)).resolves.toBe(0);
		expect(warn).not.toHaveBeenCalled();
		await expect(pruneConsentRecords(brokenD1())).resolves.toBe(0);
		expect(warn).toHaveBeenCalledTimes(1);
	});
});

describe("readConsentStats — the admin page's Berlin days", () => {
	// 2026-11-12 is winter time (Berlin = UTC+1); the oldest shown day, 2026-10-14, is still summer time (UTC+2).
	const NOW = new Date("2026-11-12T10:00:00.000Z");

	it("lists the last 30 Berlin days, today first — across the month end and the DST change; after Berlin midnight the day is the next UTC date's", async () => {
		const stats = await readConsentStats(db, NOW);
		if (!stats.ok) throw new Error(`expected figures, got ${stats.reason}`);
		const days = stats.days.map((d) => d.day);
		expect(days).toHaveLength(CONSENT_STATS_DAYS);
		expect(days[0]).toBe("2026-11-12");
		expect(days[12]).toBe("2026-10-31");
		expect(days[29]).toBe("2026-10-14");
		const late = await readConsentStats(db, new Date("2026-11-11T23:30:00.000Z"));
		if (!late.ok) throw new Error("expected figures");
		expect(late.days[0]!.day).toBe("2026-11-12");
	});

	it("counts per Berlin day and action, the granted categories, and the totals — records outside the 30 days count nowhere", async () => {
		seed("2026-11-12T09:59:00.000Z", "accept", 1, 1);
		seed("2026-11-12T08:00:00.000Z", "reject", 0, 0);
		seed("2026-11-11T23:30:00.000Z", "save", 1, 0); // Berlin 00:30 on 11-12 → today
		seed("2026-11-11T22:30:00.000Z", "withdraw", 0, 1); // Berlin 23:30 on 11-11
		seed("2026-10-13T22:30:00.000Z", "accept", 1, 1); // Berlin 00:30 CEST on 10-14 → the oldest day
		seed("2026-10-13T21:30:00.000Z", "accept", 1, 1); // Berlin 23:30 CEST on 10-13 → outside
		seed("2026-09-01T12:00:00.000Z", "accept", 1, 1); // long outside
		const stats = await readConsentStats(db, NOW);
		if (!stats.ok) throw new Error(`expected figures, got ${stats.reason}`);
		expect(stats.days).toHaveLength(30);
		const day = (d: string) => stats.days.find((x) => x.day === d);
		expect(day("2026-11-12")).toEqual({ day: "2026-11-12", accept: 1, reject: 1, save: 1, withdraw: 0, total: 3, analytics: 2, marketing: 1 });
		expect(day("2026-11-11")).toEqual({ day: "2026-11-11", accept: 0, reject: 0, save: 0, withdraw: 1, total: 1, analytics: 0, marketing: 1 });
		expect(day("2026-10-14")).toEqual({ day: "2026-10-14", accept: 1, reject: 0, save: 0, withdraw: 0, total: 1, analytics: 1, marketing: 1 });
		expect(day("2026-10-20")).toEqual({ day: "2026-10-20", accept: 0, reject: 0, save: 0, withdraw: 0, total: 0, analytics: 0, marketing: 0 });
		expect(stats.totals).toEqual({ accept: 2, reject: 1, save: 1, withdraw: 1, total: 5, analytics: 3, marketing: 3 });
	});

	it("aggregates in SQL — one grouped row per hour and action, never one per record — answered from the covering index alone", async () => {
		for (let i = 0; i < 50; i++) seed("2026-11-12T09:15:00.000Z", i % 2 ? "accept" : "reject", i % 2, 0);
		const rec = recordingD1(sqlite);
		const stats = await readConsentStats(rec.db, NOW);
		if (!stats.ok) throw new Error("expected figures");
		expect(stats.totals.total).toBe(50);
		expect(rec.bound).toHaveLength(1);
		const { sql, args } = rec.bound[0]!;
		// The statement itself returns the GROUPS: 50 records in one hour, two actions → two rows.
		expect(sqlite.prepare(sql).all(...(args as never[]))).toHaveLength(2);
		const plan = queryPlan(sql, args);
		expect(plan.some((d) => /USING COVERING INDEX idx_consent_records_created_at \(created_at>\?\)/.test(d)), plan.join(" | ")).toBe(true);
		expect(plan.filter((d) => /consent_records/.test(d) && !/COVERING INDEX/.test(d)), "no table access").toEqual([]);
	});

	it("names the gap instead of throwing: no database, no table yet, a failed read", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await expect(readConsentStats(undefined, NOW)).resolves.toEqual({ ok: false, reason: "no-database" });
		const empty = new DatabaseSync(":memory:");
		try {
			await expect(readConsentStats(sqliteD1(empty), NOW)).resolves.toEqual({ ok: false, reason: "table-missing" });
		} finally {
			empty.close();
		}
		await expect(readConsentStats(brokenD1(), NOW)).resolves.toEqual({ ok: false, reason: "read-failed" });
		expect(warn).toHaveBeenCalledTimes(1);
	});
});
