// @vitest-environment node
/**
 * The WordPress plugin (adapters/wordpress/README.md):
 *   - its generated files — fragments/ (the HTML adapter's fragments with placeholders as values) and helper/ (the PHP
 *     helper's src/) — are the committed copies of a fresh generation, and those folders hold nothing else (the drift
 *     guard: `npm run build`);
 *   - every placeholder in the templates is one that includes/Site.php fills, as often as the markup has it;
 *   - the plugin's version is the kit's.
 * The PHP part runs in PHPUnit (test/SiteTest.php, the gate) and in a real WordPress (test/run.sh, by hand).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO } from "../../../kit/build.mjs";
import { generate } from "../generate.mjs";

const PLUGIN = path.join(REPO, "adapters/wordpress/consent-kit");
/** The files below `dir` of the plugin folder, as paths relative to the plugin folder. */
const files = (dir: string) =>
	readdirSync(path.join(PLUGIN, dir), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => path.relative(PLUGIN, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));

describe("generated files (drift guard)", () => {
	it.each(Object.entries(generate()))("adapters/wordpress/consent-kit/%s is the committed copy of a fresh generation (npm run build)", (rel, text) => {
		expect(readFileSync(path.join(PLUGIN, rel), "utf8")).toBe(text);
	});

	it("fragments/ and helper/ hold that one generation and nothing else (a new kit.js is a new kit.<sha256>.js: npm run build replaces both)", () => {
		expect([...files("fragments"), ...files("helper")].sort()).toEqual(Object.keys(generate()).sort());
	});
});

describe("the templates and includes/Site.php", () => {
	const generated = generate();
	const site = readFileSync(path.join(PLUGIN, "includes/Site.php"), "utf8");
	/** Each placeholder of a template and how often it occurs. */
	const placeholders = (text: string) => {
		const counts: Record<string, number> = {};
		for (const [match] of text.matchAll(/\{\{[^}]*\}\}/g)) counts[match] = (counts[match] ?? 0) + 1;
		return counts;
	};

	it.each(Object.keys(generated).filter((rel) => rel.endsWith(".html")))("%s holds only the placeholders Site.php fills", (rel) => {
		const expected: Record<string, Record<string, number>> = {
			"head.html": { "{{config}}": 1 },
			"banner.html": { "{{endpoint}}": 1, "{{site}}": 1, "{{privacyUrl}}": 2, "{{imprintUrl}}": 2 },
			"footer-link.html": { "{{privacyUrl}}": 1 },
			"script.html": { "{{kitPath}}": 1 },
			"consent-mode.html": {},
		};
		const text = generated[rel] ?? "";
		const counts = placeholders(text);
		expect(counts).toEqual(expected[path.basename(rel)]);
		for (const placeholder of Object.keys(counts)) {
			// the config block holds its placeholder as a JSON string: Site.php replaces it with its quotes
			const key = placeholder === "{{config}}" ? `"${placeholder}"` : placeholder;
			expect(text).toContain(key);
			expect(site, key).toContain(`'${key}' =>`);
		}
	});
});

describe("the plugin header", () => {
	it("Version is the kit's version (package.json), and no Author line names anyone", () => {
		const header = readFileSync(path.join(PLUGIN, "consent-kit.php"), "utf8");
		const { version } = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as { version: string };
		expect(header).toContain(`\n * Version: ${version}\n`);
		expect(header).not.toMatch(/^ \* Author/m);
	});
});
