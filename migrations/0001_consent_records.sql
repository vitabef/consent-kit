-- 0001 of the consent records database (binding CONSENT_DB,
-- jurisdiction eu — wrangler.toml): one row per consent decision the consent
-- kit reports through `POST /v1/record` (worker/src/record.ts) — a record of
-- the PROCESS, not of a person: no IP address, no user agent, no id from the
-- client. The Worker validates every field and writes `created_at` itself (UTC
-- ISO 8601, `Date#toISOString`, so the strings sort by time). Retention: 3
-- years, pruned by the hourly cron (worker/src/scheduled.ts →
-- worker/src/records-db.ts). The index leads with `created_at` for that prune
-- and COVERS the admin page's 30-day aggregate („Einwilligungen",
-- worker/src/admin.tsx — grouped in SQL by hour and action, summing the two
-- categories): both are answered from the index alone, never from the table
-- rows (pinned by EXPLAIN QUERY PLAN in worker/test/records-db.test.ts).
--
-- Wrangler records an applied migration by this file name, so `wrangler d1
-- migrations apply` counts it as applied — keep the name. Additive (a new
-- table, `IF NOT EXISTS`); later migrations stay additive too.
CREATE TABLE IF NOT EXISTS consent_records (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	-- the kit's site id, from the server's allowlist (`SITES`, e.g. `example-site`)
	site       TEXT NOT NULL,
	-- the banner revision the decision was made on (a bump re-asks everyone)
	revision   INTEGER NOT NULL,
	analytics  INTEGER NOT NULL CHECK (analytics IN (0, 1)),
	marketing  INTEGER NOT NULL CHECK (marketing IN (0, 1)),
	-- `withdraw` = a granted category was denied
	action     TEXT NOT NULL CHECK (action IN ('accept', 'reject', 'save', 'withdraw')),
	-- the page language (`de` | `en`)
	lang       TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consent_records_created_at
	ON consent_records (created_at, action, analytics, marketing);
