/**
 * The hourly cron (wrangler.toml `17 * * * *`): the consent records' 3-year retention — at most 5,000
 * rows a tick (worker/src/records-db.ts), so a backlog is worked off over several hours. Bounded,
 * idempotent, never throws: a failure is logged and the next tick tries again. Without the database
 * binding there is nothing to prune.
 */
import type { Env } from "./env";
import { CONSENT_RECORD_RETENTION_YEARS, pruneConsentRecords } from "./records-db";

export async function runRetention(env: Env): Promise<void> {
	try {
		const pruned = await pruneConsentRecords(env.CONSENT_DB);
		if (pruned > 0) {
			console.log(`[cron] consent_records retention: ${pruned} rows older than ${CONSENT_RECORD_RETENTION_YEARS} years pruned`);
		}
	} catch (err) {
		console.warn("[cron] consent_records retention prune threw:", err instanceof Error ? err.message : err);
	}
}
