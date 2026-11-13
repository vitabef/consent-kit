/**
 * The `consent_records` table of the EU database (binding `CONSENT_DB`;
 * migrations/0001): the insert behind `POST /v1/record`, the 3-year retention prune of the hourly cron
 * (worker/src/scheduled.ts), and the 30-day counts of the admin page (worker/src/admin.tsx).
 *
 * A row carries the validated decision (worker/src/contract.ts) and the server's time — no IP address,
 * no user agent, no client id. `created_at` is ALWAYS written here, as `Date#toISOString()`
 * (`YYYY-MM-DDTHH:mm:ss.sssZ`), so the strings sort by time: the retention cutoff and the admin window
 * are plain string comparisons the `created_at` index serves.
 *
 * The binding is OPTIONAL (worker/src/env.ts): absent, the route drops the record (after the body read,
 * the `SITES` check and the validation — before any rate-limit token is spent), the prune does nothing and
 * the read answers `no-database`.
 *
 * Nothing here throws: the insert and the prune log and report failure (`false` / 0), the read returns
 * `ok: false` with the reason.
 */
import { CONSENT_ACTIONS, isOneOf, type ConsentRecord } from "./contract";

/** How long a record is kept, in years. */
export const CONSENT_RECORD_RETENTION_YEARS = 3;

/** Berlin days the admin page shows, today included. */
export const CONSENT_STATS_DAYS = 30;

/**
 * Store one validated record with the server's time. `false` (logged WITHOUT the record) on any D1
 * failure — the caller answers the same either way.
 */
export async function insertConsentRecord(db: D1Database, record: ConsentRecord, now: Date = new Date()): Promise<boolean> {
	try {
		await db
			.prepare(
				`INSERT INTO consent_records (site, revision, analytics, marketing, action, lang, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(record.site, record.revision, record.analytics, record.marketing, record.action, record.lang, now.toISOString())
			.run();
		return true;
	} catch (err) {
		console.warn("[consent-records] insert failed — record dropped:", err instanceof Error ? err.message : err);
		return false;
	}
}

/** `now` minus {@link CONSENT_RECORD_RETENTION_YEARS} calendar years (UTC), in the stored ISO shape. */
function consentRetentionCutoff(now: Date): string {
	const cutoff = new Date(now.getTime());
	cutoff.setUTCFullYear(cutoff.getUTCFullYear() - CONSENT_RECORD_RETENTION_YEARS);
	return cutoff.toISOString();
}

/**
 * Rows one prune call may delete — the hourly tick's bound. The rows are FOUND through the covering
 * index alone; at 5,000 an hour (120,000 a day) a day at the global breaker's cap (300 a minute =
 * 432,000 at one location) clears in under four days, not a month.
 */
const CONSENT_PRUNE_BATCH = 5_000;

/** The batch option clamped into [1, max]; a missing or non-finite value takes `fallback`. */
function clampBatch(raw: number | undefined, fallback: number, max: number): number {
	return Math.max(1, Math.min(max, Math.trunc(Number.isFinite(raw) ? (raw as number) : fallback)));
}

/**
 * Delete the oldest records older than the retention window — at most `batchSize` per call (clamped
 * into [1, {@link CONSENT_PRUNE_BATCH}], default {@link CONSENT_PRUNE_BATCH}); the hourly tick works a
 * backlog off over several hours. Returns the rows deleted: 0 when nothing matches, without a database
 * (nothing to prune) or on a swallowed D1 error. Idempotent.
 */
export async function pruneConsentRecords(db: D1Database | undefined, options?: { now?: Date; batchSize?: number }): Promise<number> {
	if (!db) return 0;
	try {
		const r = await db
			.prepare(
				`DELETE FROM consent_records WHERE id IN (
					SELECT id FROM consent_records WHERE created_at < ? ORDER BY created_at LIMIT ?
				)`,
			)
			.bind(consentRetentionCutoff(options?.now ?? new Date()), clampBatch(options?.batchSize, CONSENT_PRUNE_BATCH, CONSENT_PRUNE_BATCH))
			.run();
		return r.meta?.changes ?? 0;
	} catch (err) {
		console.warn("[consent-records] retention prune failed (non-fatal):", err instanceof Error ? err.message : err);
		return 0;
	}
}

/** Counts over a set of records: one per action, all of them, and how many granted each category. */
export interface ConsentCounts {
	accept: number;
	reject: number;
	save: number;
	withdraw: number;
	/** every record (the four actions together) */
	total: number;
	/** records with analytics granted (`a` = 1) */
	analytics: number;
	/** records with marketing granted (`m` = 1) */
	marketing: number;
}

/** One Berlin day's counts. */
export interface ConsentDayCounts extends ConsentCounts {
	/** `YYYY-MM-DD`, Europe/Berlin */
	day: string;
}

/** Why the figures are not there: no database bound, the table not migrated yet, or the read failed. */
export type ConsentStatsGap = "no-database" | "table-missing" | "read-failed";

export type ConsentStats = { ok: true; days: ConsentDayCounts[]; totals: ConsentCounts } | { ok: false; reason: ConsentStatsGap };

const emptyCounts = (): ConsentCounts => ({ accept: 0, reject: 0, save: 0, withdraw: 0, total: 0, analytics: 0, marketing: 0 });

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The Europe/Berlin calendar date of an instant, `YYYY-MM-DD`. */
function berlinDate(at: Date): string {
	return at.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
}

/** The last `days` Berlin dates up to `now`'s, newest first (calendar arithmetic in UTC: no DST step). */
function lastBerlinDays(now: Date, days: number): string[] {
	const [y, m, d] = berlinDate(now).split("-").map(Number) as [number, number, number];
	return Array.from({ length: days }, (_, i) => new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));
}

/**
 * The admin page's figures: per Berlin day for the last {@link CONSENT_STATS_DAYS} days (today first;
 * a day without records reads 0), and their totals. ONE read, aggregated in SQL: the window's records
 * grouped by UTC hour and action, the two categories summed — at most 24 × 31 × 4 rows come back,
 * whatever the volume, and the covering index (migrations/0001) answers it without touching the table.
 * Berlin is a whole number of hours off UTC, so every hour folds into exactly one Berlin day here, DST
 * included. The read starts a day early (the oldest Berlin day begins up to two hours before its UTC
 * date); hours outside the shown days are skipped.
 */
export async function readConsentStats(db: D1Database | undefined, now: Date = new Date()): Promise<ConsentStats> {
	if (!db) return { ok: false, reason: "no-database" };
	const days = lastBerlinDays(now, CONSENT_STATS_DAYS);
	const since = new Date(now.getTime() - (CONSENT_STATS_DAYS + 1) * 86_400_000).toISOString();
	let rows: Array<{ hour: unknown; action: unknown; n: unknown; a: unknown; m: unknown }>;
	try {
		const res = await db
			.prepare(
				`SELECT substr(created_at, 1, 13) AS hour, action, COUNT(*) AS n, SUM(analytics) AS a, SUM(marketing) AS m
				 FROM consent_records
				 WHERE created_at >= ?
				 GROUP BY hour, action`,
			)
			.bind(since)
			.all<{ hour: unknown; action: unknown; n: unknown; a: unknown; m: unknown }>();
		rows = res.results ?? [];
	} catch (err) {
		const message = err instanceof Error ? err.message : err;
		if (typeof message === "string" && /no such table/i.test(message)) return { ok: false, reason: "table-missing" };
		console.warn("[consent-records] stats read failed:", message);
		return { ok: false, reason: "read-failed" };
	}
	const byDay = new Map(days.map((day) => [day, emptyCounts()] as const));
	const totals = emptyCounts();
	for (const row of rows) {
		if (typeof row.hour !== "string" || !isOneOf(CONSENT_ACTIONS, row.action)) continue;
		const at = new Date(`${row.hour}:00:00.000Z`);
		if (Number.isNaN(at.getTime())) continue;
		const bucket = byDay.get(berlinDate(at));
		if (!bucket) continue;
		for (const target of [bucket, totals]) {
			target[row.action] += count(row.n);
			target.total += count(row.n);
			target.analytics += count(row.a);
			target.marketing += count(row.m);
		}
	}
	return { ok: true, days: days.map((day) => ({ day, ...(byDay.get(day) ?? emptyCounts()) })), totals };
}
