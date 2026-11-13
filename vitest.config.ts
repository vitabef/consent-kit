/// <reference types="vitest" />
import { defineConfig } from "vitest/config";

/**
 * Three suites, one run:
 *   kit/test/**            — the browser kit: kit.test.ts runs the minified bytes in happy-dom (its own
 *                            `@vitest-environment happy-dom` pragma), build.test.ts in node;
 *   adapters/<name>/test/** — the site adapters in node (the Hugo one builds its example site with Hugo);
 *   worker/test/**         — the records Worker in node (node:sqlite behind the D1 slice the code uses).
 * Globals on: the kit tests use describe / it / expect / vi without importing them.
 */
export default defineConfig({
	test: {
		globals: true,
		include: ["kit/test/**/*.test.ts", "adapters/*/test/**/*.test.ts", "worker/test/**/*.test.ts"],
		exclude: ["node_modules/**", ".tmp/**", ".wrangler/**"],
		isolate: true,
		testTimeout: 15000,
	},
});
