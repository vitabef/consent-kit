/**
 * `GET /admin` — „Einwilligungen": the decisions the consent kit records through `POST /v1/record` —
 * per Europe/Berlin day for the last 30 days, the count per action (accept / reject / save /
 * withdraw) and the share of records with statistics / marketing granted, plus the 30-day totals.
 * A standalone page: no layout framework, no script, ONE read of the database (`readConsentStats`) —
 * without the `CONSENT_DB` binding, or before its migration, the page says „Keine Daten“; no export
 * (`wrangler d1 export` on demand).
 *
 * Behind Cloudflare Access (worker/src/access.ts): without a valid token the answer is a plain 403
 * and the database is never read. Every response here is `no-store`, `noindex`, never framed, and
 * carries a CSP that allows no script at all. Output is escaped by hono/jsx (the only outside string
 * shown is the `SITES` var).
 */
import type { Context } from "hono";
import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import type { HonoEnv } from "./env";
import { hasAdminAccess } from "./access";
import { CONSENT_ACTIONS, allowedSites, type ConsentAction } from "./contract";
import {
	CONSENT_RECORD_RETENTION_YEARS,
	CONSENT_STATS_DAYS,
	readConsentStats,
	type ConsentCounts,
	type ConsentDayCounts,
	type ConsentStats,
	type ConsentStatsGap,
} from "./records-db";

/** The admin page's, its refusal's and its error's headers (worker/src/index.ts `onError`): never cached,
 *  never indexed, no script, never framed. */
export const ADMIN_HEADERS: Record<string, string> = {
	"Cache-Control": "no-store",
	"X-Robots-Tag": "noindex, nofollow",
	"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
};

const INTEGER = new Intl.NumberFormat("de-DE");
const PERCENT = new Intl.NumberFormat("de-DE", { style: "percent", maximumFractionDigits: 0 });

const fmtCount = (n: number): string => INTEGER.format(n);

/** The share `part / total` as a whole percentage — "—" when there is nothing to divide. */
const fmtShare = (part: number, total: number): string => (total > 0 ? PERCENT.format(part / total) : "—");

/** `2026-11-12` → `Do., 12.11.2026` (the date is already a Berlin calendar date). */
function fmtDay(day: string): string {
	const [y, m, d] = day.split("-").map(Number) as [number, number, number];
	return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("de-DE", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
}

/** The German label of each action — a `Record`, so a new action cannot ship without one. */
const ACTION_LABELS: Record<ConsentAction, string> = {
	accept: "Akzeptiert",
	reject: "Abgelehnt",
	save: "Auswahl gespeichert",
	withdraw: "Widerrufen",
};

/** The actions in the contract's order, with their labels. */
const ACTION_COLUMNS = CONSENT_ACTIONS.map((action): [ConsentAction, string] => [action, ACTION_LABELS[action]]);

/** The categories as the banner names them („Statistik“, „Marketing“). */
const STATISTICS_LABEL = "Statistik erlaubt";
const MARKETING_LABEL = "Marketing erlaubt";

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#212529;--muted:#5c636a;--line:#dee2e6;--band:#f3f5f7;--accent:#1d4163;--note-bg:#fff4d6;--note-fg:#5c4400;--error:#a4232f}
@media (prefers-color-scheme:dark){:root{--bg:#212529;--fg:#dee2e6;--muted:#adb5bd;--line:#495057;--band:#2b3035;--accent:#7fa6cf;--note-bg:#3a2e08;--note-fg:#ffd978;--error:#f1a1a8}}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
::selection{background:var(--accent);color:var(--bg)}
main{max-width:72rem;margin:0 auto;padding:2rem 1rem 3rem}
h1{margin:0 0 .75rem;font-size:1.5rem;line-height:1.25;font-weight:650}
h2{margin:2.25rem 0 .75rem;font-size:1rem;line-height:1.3;font-weight:650}
p{margin:0 0 .75rem;max-width:75ch;color:var(--muted)}
p strong{color:var(--fg);font-weight:600}
code{font:.875em/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,9rem),1fr));gap:1.25rem 1.5rem;margin:0}
.kpis+.kpis{margin-top:1.25rem}
.kpi{margin:0;padding-top:.625rem;border-top:1px solid var(--line)}
.kpi dt{font-size:.8125rem;line-height:1.3;color:var(--muted)}
.kpi dd{margin:.25rem 0 0;font-size:1.375rem;line-height:1.2;font-weight:600;font-variant-numeric:tabular-nums}
.kpi dd small{display:block;margin-top:.125rem;font-size:.8125rem;line-height:1.3;font-weight:400;color:var(--muted)}
.table{margin:2.25rem -1rem 0;overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.875rem;line-height:1.4;font-variant-numeric:tabular-nums}
caption{padding:.75rem 1rem;text-align:start;font-weight:600}
th,td{padding:.5rem 1rem;border-top:1px solid var(--line);text-align:end;white-space:nowrap}
th:first-child,td:first-child{text-align:start}
thead th{background:var(--band);font-weight:600}
td.sum{font-weight:600}
.note{margin:0;padding:.75rem 1rem;border-radius:.375rem;background:var(--note-bg);color:var(--note-fg)}
.note strong{color:inherit}
.error{color:var(--error)}
`;

/** The 30-day totals: the counts (all decisions, then one per action), then the two shares. */
const Totals: FC<{ totals: ConsentCounts }> = ({ totals }) => (
	<section aria-labelledby="totals">
		<h2 id="totals">Letzte {CONSENT_STATS_DAYS} Tage</h2>
		<dl class="kpis">
			<div class="kpi">
				<dt>Entscheidungen</dt>
				<dd>{fmtCount(totals.total)}</dd>
			</div>
			{ACTION_COLUMNS.map(([key, label]) => (
				<div class="kpi">
					<dt>{label}</dt>
					<dd>{fmtCount(totals[key])}</dd>
				</div>
			))}
		</dl>
		<dl class="kpis">
			<div class="kpi">
				<dt>{STATISTICS_LABEL}</dt>
				<dd>
					{fmtShare(totals.analytics, totals.total)}
					<small>
						{fmtCount(totals.analytics)} von {fmtCount(totals.total)}
					</small>
				</dd>
			</div>
			<div class="kpi">
				<dt>{MARKETING_LABEL}</dt>
				<dd>
					{fmtShare(totals.marketing, totals.total)}
					<small>
						{fmtCount(totals.marketing)} von {fmtCount(totals.total)}
					</small>
				</dd>
			</div>
		</dl>
	</section>
);

const DailyTable: FC<{ days: ConsentDayCounts[] }> = ({ days }) => (
	<div class="table">
		<table>
			<caption>
				Einwilligungen je Tag — letzte {CONSENT_STATS_DAYS} Tage, neueste zuerst
			</caption>
			<thead>
				<tr>
					<th scope="col">Tag</th>
					{ACTION_COLUMNS.map(([, label]) => (
						<th scope="col">{label}</th>
					))}
					<th scope="col">Gesamt</th>
					<th scope="col">{STATISTICS_LABEL}</th>
					<th scope="col">{MARKETING_LABEL}</th>
				</tr>
			</thead>
			<tbody>
				{days.map((day) => (
					<tr data-consent-day={day.day}>
						<th scope="row">{fmtDay(day.day)}</th>
						{ACTION_COLUMNS.map(([key]) => (
							<td>{fmtCount(day[key])}</td>
						))}
						<td class="sum">{fmtCount(day.total)}</td>
						<td>{fmtShare(day.analytics, day.total)}</td>
						<td>{fmtShare(day.marketing, day.total)}</td>
					</tr>
				))}
			</tbody>
		</table>
	</div>
);

/** Why there are no figures: no database bound, the migration not applied, or a failed read. */
const Gap: FC<{ reason: ConsentStatsGap }> = ({ reason }) =>
	reason === "read-failed" ? (
		<p role="alert" class="note error" data-consent-gap={reason}>
			<strong>Fehler beim Laden der Einwilligungen.</strong> Die Einträge konnten nicht gelesen werden. Bitte die Seite später neu
			laden.
		</p>
	) : (
		<p role="status" class="note" data-consent-gap={reason}>
			<strong>Keine Daten.</strong>{" "}
			{reason === "no-database" ? (
				<>
					Die Datenbank für Einwilligungen ist nicht angebunden (Binding <code>CONSENT_DB</code>).
				</>
			) : (
				<>
					Tabelle <code>consent_records</code> fehlt — Migration <code>migrations/0001</code> wurde noch nicht angewendet.
				</>
			)}
		</p>
	);

const Page: FC<{ stats: ConsentStats; sites: string[] }> = ({ stats, sites }) => (
	<>
		{raw("<!doctype html>")}
		<html lang="de">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="robots" content="noindex, nofollow" />
				<title>Einwilligungen — Consent-Kit</title>
				<style>{raw(STYLE)}</style>
			</head>
			<body>
				<main>
					<h1>Einwilligungen (Cookie-Banner)</h1>
					<p>
						Die Cookie-Entscheidungen, die der Consent-Banner der angebundenen Websites meldet
						{sites.length > 0 ? <> (Site-IDs: {sites.join(", ")})</> : <> (keine Site-ID freigegeben: Variable <code>SITES</code> ist leer, es wird nichts gespeichert)</>}: je
						Entscheidung ein Eintrag mit Aktion, erlaubten Kategorien, Seitensprache und Banner-Version; die Uhrzeit setzt der Server.
						Keine IP-Adresse, kein Browser, keine Besucher-ID. Einträge werden nach {CONSENT_RECORD_RETENTION_YEARS} Jahren automatisch
						gelöscht.
					</p>
					<p>
						<strong>Akzeptiert</strong>: alle Kategorien erlaubt · <strong>Abgelehnt</strong>: alle optionalen Kategorien abgelehnt ·{" "}
						<strong>Auswahl gespeichert</strong>: Auswahl in den Einstellungen gespeichert · <strong>Widerrufen</strong>: eine zuvor
						erlaubte Kategorie abgewählt — der Eintrag trägt die neue Wahl des Besuchers (er zählt nicht zusätzlich als Abgelehnt oder
						Auswahl gespeichert). „Statistik/Marketing erlaubt“: Anteil aller Einträge, in denen die Kategorie erlaubt ist — die neue
						Wahl aus Widerrufen eingeschlossen. Tage nach deutscher Zeit.
					</p>
					{stats.ok ? (
						<>
							<Totals totals={stats.totals} />
							<DailyTable days={stats.days} />
						</>
					) : (
						<Gap reason={stats.reason} />
					)}
				</main>
			</body>
		</html>
	</>
);

/** The route handler: 403 without a valid Access token (the database is never read), else the page. */
export async function handleAdmin(c: Context<HonoEnv>): Promise<Response> {
	const env = c.env ?? {};
	if (!(await hasAdminAccess(c.req.raw, env))) return c.text("Forbidden", 403, ADMIN_HEADERS);
	const stats = await readConsentStats(env.CONSENT_DB);
	return c.html(<Page stats={stats} sites={allowedSites(env.SITES)} />, 200, ADMIN_HEADERS);
}
