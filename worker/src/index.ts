/**
 * The consent records Worker (on its custom domain, wrangler.toml):
 *   POST /v1/record — the consent kit's decision records; always 204 (worker/src/record.ts);
 *   GET  /admin     — the daily counts, behind Cloudflare Access (worker/src/admin.tsx);
 *   every other path or method — 404;
 *   an error no route catches — a bare 500 (onError below);
 *   cron, hourly    — the 3-year retention prune (worker/src/scheduled.ts).
 * No middleware: neither route reads or sets a cookie, nothing is logged per request.
 */
import { Hono, type Context } from "hono";
import type { HonoEnv, Env } from "./env";
import { RECORD_PATH } from "./contract";
import { handleRecord } from "./record";
import { ADMIN_HEADERS, handleAdmin } from "./admin";
import { runRetention } from "./scheduled";

export const app = new Hono<HonoEnv>();

/**
 * What no route caught (neither is expected to throw: the record route answers 204 whatever happens, the
 * admin gate denies by default): a bare 500 with no body, never cached — on `/admin` with the admin page's
 * own headers, so that every admin response carries them. Logged with the error's message only, never
 * the request. Never throws.
 */
export function onError(err: unknown, c: Context<HonoEnv>): Response {
	console.warn("[consent] unexpected failure — 500:", err instanceof Error ? err.message : err);
	return new Response(null, { status: 500, headers: c.req.path === "/admin" ? ADMIN_HEADERS : { "Cache-Control": "no-store" } });
}

app.post(RECORD_PATH, handleRecord);
app.get("/admin", handleAdmin);
app.notFound((c) => c.text("Not Found", 404));
app.onError(onError);

export default {
	fetch: app.fetch,
	async scheduled(_controller, env, _ctx) {
		await runRetention(env);
	},
} satisfies ExportedHandler<Env>;
