/**
 * A node:sqlite `DatabaseSync` behind the slice of the D1 API the Worker uses
 * (`prepare().bind().run()/all()/first()`), so a statement's SEMANTICS — which rows are written,
 * which survive a prune, what a read returns — are proven against a real SQL engine. Close the
 * DatabaseSync in `afterEach`.
 */
import type { DatabaseSync } from "node:sqlite";

export function sqliteD1(sqlite: DatabaseSync): D1Database {
	return {
		prepare(sql: string) {
			const stmt = sqlite.prepare(sql);
			let bound: unknown[] = [];
			const api = {
				bind(...args: unknown[]) {
					bound = args;
					return api;
				},
				async run() {
					const r = stmt.run(...(bound as never[]));
					return { meta: { changes: Number(r.changes) } };
				},
				async all() {
					return { results: stmt.all(...(bound as never[])) };
				},
				async first() {
					return stmt.get(...(bound as never[])) ?? null;
				},
			};
			return api;
		},
	} as unknown as D1Database;
}
