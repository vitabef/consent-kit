// @vitest-environment node
/**
 * The WordPress plugin (adapters/wordpress/README.md):
 *   - its generated files — fragments/ (the HTML adapter's fragments with placeholders as values, the strings'
 *     included), i18n/ (the kit's sample strings) and helper/ (the PHP helper's src/) — are the committed copies of a
 *     fresh generation, and those folders hold nothing else; so is test/texts/, the HTML adapter's rendering of the
 *     texts fixture (the drift guard: `npm run build`);
 *   - every placeholder in the templates is one that includes/Site.php fills, as often as the markup has it;
 *   - the plugin's version is the kit's.
 * The PHP part runs in PHPUnit (test/SiteTest.php, the gate) and in a real WordPress (test/run.sh, by hand).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { LANGS, REPO, strings } from "../../../kit/build.mjs";
import { generate, textsFixture } from "../generate.mjs";

const PLUGIN = path.join(REPO, "adapters/wordpress/consent-kit");
/** The kit's string keys (kit/src/i18n/<lang>.json without its note). */
const keys = Object.keys(strings(LANGS[0] ?? "")).filter((key) => key !== "_note");
/** The files below `dir` of the plugin folder, as paths relative to the plugin folder. */
const files = (dir: string) =>
	readdirSync(path.join(PLUGIN, dir), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => path.relative(PLUGIN, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));

describe("generated files (drift guard)", () => {
	it.each(Object.entries(generate()))("adapters/wordpress/consent-kit/%s is the committed copy of a fresh generation (npm run build)", (rel, text) => {
		expect(readFileSync(path.join(PLUGIN, rel), "utf8")).toBe(text);
	});

	it("fragments/, helper/ and i18n/ hold that one generation and nothing else (a new kit.js is a new kit.<sha256>.js: npm run build replaces them)", () => {
		expect([...files("fragments"), ...files("helper"), ...files("i18n")].sort()).toEqual(Object.keys(generate()).sort());
	});

	it.each(Object.entries(textsFixture()))("adapters/wordpress/%s, the HTML adapter's rendering of test/texts.json that test/SiteTest.php holds the plugin's to, is the committed copy (npm run build)", (rel, text) => {
		expect(readFileSync(path.join(REPO, "adapters/wordpress", rel), "utf8")).toBe(text);
	});

	it("the texts fixture holds what the plugin's rendering must match: a </script>, quotes, an & and an entity, a {{placeholder}} as text, a text in two blocks", () => {
		const banner = textsFixture()["test/texts/banner.html"] ?? "";
		expect(banner).toContain("&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;, 'apostrophes' and {{site}}");
		expect(banner).toContain("&amp;amp; as written");
		expect(banner.match(/class="ck-cc-s"/g)).toHaveLength(2);
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
	/** A string of the kit — {{key}} or {{key|blocks}} — which Site.php fills from i18n/<lang>.json, not by its name. */
	const isString = (placeholder: string) => keys.includes(placeholder.slice(2, -2).replace(/\|blocks$/, ""));

	it.each(Object.keys(generated).filter((rel) => rel.endsWith(".html")))("%s holds only the placeholders Site.php fills", (rel) => {
		const expected: Record<string, Record<string, number>> = {
			"head.html": { "{{config}}": 1 },
			"banner.html": {
				"{{title}}": 1, "{{text|blocks}}": 1, "{{privacy}}": 2, "{{imprint}}": 2, "{{acceptAll}}": 2, "{{rejectAll}}": 2, "{{settings}}": 1,
				"{{dialogTitle}}": 1, "{{close}}": 1, "{{analytics}}": 1, "{{analyticsDetails}}": 1, "{{marketing}}": 1, "{{marketingDetails}}": 1,
				"{{saveChoice}}": 1, "{{endpoint}}": 1, "{{site}}": 1, "{{privacyUrl}}": 2, "{{imprintUrl}}": 2,
			},
			"footer-link.html": { "{{privacyUrl}}": 1, "{{dialogTitle}}": 1 },
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
			// banner.html's strings are filled by key, each in both forms: SiteTest.php's byte-for-byte checks prove it
			if (!(path.basename(rel) === "banner.html" && isString(placeholder))) expect(site, key).toContain(`'${key}' =>`);
		}
	});
});

describe("the settings page (consent-kit.php)", () => {
	it("every string of the kit has a field with a label and a note of its own, in the kit's order; no label is used twice", () => {
		const page = readFileSync(path.join(PLUGIN, "consent-kit.php"), "utf8");
		const texts = Object.fromEntries(Array.from(page.matchAll(/^ {8}'(\w+)' => \['([^']+)', '[^']/gm), (m) => [m[1], m[2]]));
		const fields = Array.from(page.matchAll(/^ {8}\[\[[^\]]+\], '([^']+)'/gm), (m) => m[1]);
		expect(Object.keys(texts)).toEqual(keys);
		expect(fields).toHaveLength(16);
		const labels = [...fields, ...Object.values(texts)];
		expect(labels.filter((label, i) => labels.indexOf(label) !== i)).toEqual([]);
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
