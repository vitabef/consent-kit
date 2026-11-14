// @vitest-environment node
/**
 * Consent kit — the build artefacts: the brotli budgets of the three shipped files (~1.5 × the first build,
 * inside the hard ceilings head ≤ 1 KB, CSS ≤ 3 KB, JS ≤ 6 KB), the committed copy of those files in dist/ (the
 * drift guard), the structure of the DE/EN sample strings (the same keys — exactly the ones the reference markup
 * needs, plus the `_note` — every one filled; the wording itself is a site's own) and the reference markup / demo
 * rendering without a missing placeholder, the first-layer text in blocks (one span per line).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUDGETS, COMMITTED_DIST, blocks, buildAssets, fileText, measure, renderBanner, renderDemo, replacePlaceholders, strings } from "../build.mjs";

type Assets = Record<"head.js" | "kit.css" | "kit.js", string>;
let assets: Assets;

beforeAll(async () => {
	assets = await buildAssets();
});

const VARS = { privacyUrl: "/datenschutz/", imprintUrl: "/impressum/", endpoint: "https://consent.example.com/v1/record", site: "example-site" };

describe("budgets (brotli)", () => {
	it.each(Object.entries(BUDGETS))("%s stays within %i bytes", (name, budget) => {
		const text = assets[name as keyof Assets];
		expect(text.length).toBeGreaterThan(0);
		expect(measure(text).brotli).toBeLessThanOrEqual(budget);
	});

	it("the budgets sit at ~1.5 × the first build, inside the hard ceilings (1 KB / 3 KB / 6 KB)", () => {
		expect(BUDGETS).toEqual({ "head.js": 900, "kit.css": 2200, "kit.js": 2500 });
		expect(BUDGETS["head.js"]).toBeLessThanOrEqual(1024);
		expect(BUDGETS["kit.css"]).toBeLessThanOrEqual(3072);
		expect(BUDGETS["kit.js"]).toBeLessThanOrEqual(6144);
	});
});

describe("committed build output (dist/)", () => {
	it.each(Object.keys(BUDGETS))("dist/%s is the committed copy of a fresh build (npm run build)", (name) => {
		expect(readFileSync(join(COMMITTED_DIST, name), "utf8")).toBe(fileText(assets[name as keyof Assets]));
	});

	it("dist/ holds the three shipped files and nothing else (the Hugo module mounts the whole folder)", () => {
		expect(readdirSync(COMMITTED_DIST).sort()).toEqual(Object.keys(BUDGETS).sort());
	});

	it("dist/kit.css holds no </style and dist/head.js no </script, in any case: the Hugo adapter inlines them unescaped (safeCSS, safeJS)", () => {
		expect(readFileSync(join(COMMITTED_DIST, "kit.css"), "utf8")).not.toMatch(/<\/style/i);
		expect(readFileSync(join(COMMITTED_DIST, "head.js"), "utf8")).not.toMatch(/<\/script/i);
	});
});

describe("reference strings (samples)", () => {
	const de = strings("de") as Record<string, string>;
	const en = strings("en") as Record<string, string>;
	/** The kit strings the reference markup needs: its {{key}} placeholders (developer comment dropped), minus the adapter's values. */
	const ADAPTER_VALUES = ["privacyUrl", "imprintUrl", "endpoint", "site"];
	const template = readFileSync(resolve(__dirname, "../templates/banner.html"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
	const needed = [...new Set(Array.from(template.matchAll(/\{\{\s*([A-Za-z]\w*)\s*(?:\|\s*[A-Za-z]\w*\s*)?\}\}/g), (m) => m[1] ?? ""))]
		.filter((key) => !ADAPTER_VALUES.includes(key))
		.sort();

	it("DE and EN carry the same keys, every value a non-empty string", () => {
		expect(Object.keys(en).sort()).toEqual(Object.keys(de).sort());
		for (const value of [...Object.values(de), ...Object.values(en)]) {
			expect(typeof value).toBe("string");
			expect(value.trim().length).toBeGreaterThan(0);
		}
	});

	it.each([
		["de", de],
		["en", en],
	] as const)("every key the reference markup needs exists in %s and is filled — and nothing else but the `_note`", (_lang, s) => {
		expect(needed.length).toBeGreaterThan(0);
		for (const key of needed) expect(s[key]?.trim(), key).toBeTruthy();
		expect(Object.keys(s).sort()).toEqual([...needed, "_note"].sort());
	});

	it.each(["de", "en"] as const)("the rendered markup (%s) carries the strings: the three equal buttons of each layer, the save and close controls, the links to the privacy policy and the imprint in both layers", (lang) => {
		const s = strings(lang) as Record<string, string>;
		const html = renderBanner(lang, VARS);
		for (const key of ["acceptAll", "rejectAll", "settings", "saveChoice", "close"]) expect(html, key).toContain(`>${s[key]}</button>`);
		expect(html.match(/<a href="\/datenschutz\/">/g)).toHaveLength(2);
		expect(html.match(/<a href="\/impressum\/">/g)).toHaveLength(2);
	});
});

describe("rendering", () => {
	it.each(["de", "en"])("the reference markup (%s) has no unfilled placeholder and escapes values — the endpoint and site included", (lang) => {
		const html = renderBanner(lang, { ...VARS, privacyUrl: "/p/?a=1&b=2", site: 'a"b' });
		expect(html).not.toMatch(/\{\{|\}\}/);
		expect(html).toContain('href="/p/?a=1&amp;b=2"');
		expect(html).toContain('data-endpoint="https://consent.example.com/v1/record"');
		expect(html).toContain('data-site="a&quot;b"');
		expect(html).toContain(strings(lang).acceptAll);
		expect(html).toContain(`aria-label="${strings(lang).title}"`);
	});

	it.each(["privacyUrl", "imprintUrl", "endpoint", "site"])("a missing value (%s) is an error, never an empty string", (key) => {
		const vars: Record<string, string> = { ...VARS };
		delete vars[key];
		expect(() => renderBanner("de", vars)).toThrow(new RegExp(`\\{\\{${key}\\}\\}`));
	});

	it.each(["de", "en"])("the demo page (%s) carries the config block, the inline head snippet and CSS, layer 1 first in <body>, kit.js deferred — and sends no records", (lang) => {
		const html = renderDemo(lang, assets);
		expect(html).not.toMatch(/\{\{|<!--ck:/);
		expect(html).toContain(`<html lang="${lang}"`);
		expect(html).toContain('<script type="application/json" id="ck-config">');
		expect(html).toContain(`<script data-cfasync="false">${assets["head.js"]}</script>`);
		expect(html).toContain(`<style>${assets["kit.css"]}</style>`);
		expect(html).toMatch(/<body>\s*<div class="ck-cc" role="region"/);
		expect(html).toContain('<script data-cfasync="false" src="/kit.js" defer></script>');
		expect(html.indexOf("ck-config")).toBeLessThan(html.indexOf(assets["head.js"]));
		expect(html).toContain('data-endpoint="" data-site="example-site"');
		const config = JSON.parse(html.match(/<script type="application\/json" id="ck-config">(.*?)<\/script>/)?.[1] ?? "null");
		expect(config).not.toHaveProperty("records");
		expect(config).not.toHaveProperty("site");
	});

	it.each([
		["de", "#datenschutz", "#impressum"],
		["en", "#privacy", "#imprint"],
	])("the demo page (%s) links the privacy policy and the imprint with anchors in its own language — both layers and the footer", (lang, privacy, imprint) => {
		const html = renderDemo(lang, assets);
		expect(html.match(new RegExp(`href="${privacy}"`, "g"))).toHaveLength(3);
		expect(html.match(new RegExp(`href="${imprint}"`, "g"))).toHaveLength(3);
	});
});

describe("the first-layer text in blocks ({{text|blocks}})", () => {
	/** Three parts, an empty and a blank line between them, CRLF, spaces and tabs at the ends, HTML in the first. */
	const TEXT = '  First <b>part</b> & "quotes" \r\n\n \t \nSecond part\t\nThird part, the last\n';
	const THREE =
		'<p class="ck-cc-p"><span class="ck-cc-s">First &lt;b&gt;part&lt;/b&gt; &amp; &quot;quotes&quot;</span> ' +
		'<span class="ck-cc-s">Second part</span> <span class="ck-cc-s">Third part, the last</span></p>';

	it("a text with line breaks: one span per non-empty line, its ends trimmed, each part HTML-escaped, the spans joined by one space — inside the one paragraph", () => {
		const html = renderBanner("de", { ...VARS, text: TEXT });
		expect(html).toContain(THREE);
		expect(html.match(/<p class="ck-cc-p">/g)).toHaveLength(1);
		expect(html.match(/class="ck-cc-s"/g)).toHaveLength(3);
	});

	it.each(["de", "en"])("a text without a line break is exactly one span — the sample strings (%s)", (lang) => {
		const s = strings(lang) as Record<string, string>;
		expect(s.text).not.toMatch(/[\n&<>"]/); // the samples need no escape: the markup is the string as written
		expect(renderBanner(lang, VARS)).toContain(`<p class="ck-cc-p"><span class="ck-cc-s">${s.text}</span></p>`);
	});

	it("a text of empty and blank lines only renders no span; blocks() is the same markup", () => {
		expect(blocks(" \t\r\n\n\t")).toBe("");
		expect(renderBanner("de", { ...VARS, text: "\n \n" })).toContain('<p class="ck-cc-p"></p>');
		expect(blocks(TEXT)).toBe(THREE.slice('<p class="ck-cc-p">'.length, -"</p>".length));
	});

	it("only the text is split: another string keeps its line break, escaped as one text", () => {
		expect(renderBanner("de", { ...VARS, acceptAll: "Accept\n<all>" })).toContain('data-ck-action="accept">Accept\n&lt;all&gt;</button>');
	});

	it("a placeholder with another filter is an error", () => {
		expect(() => replacePlaceholders("<p>{{text|upper}}</p>", () => "")).toThrow("{{text|upper}}: no such filter (blocks)");
	});
});
