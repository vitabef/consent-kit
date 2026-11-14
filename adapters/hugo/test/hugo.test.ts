// @vitest-environment node
/**
 * The Hugo adapter (adapters/hugo/README.md):
 *   - its generated files are the committed copies of a fresh generation (the drift guard: `npm run build`), in YAML
 *     that keeps every string and every comment on its own line;
 *   - built with Hugo 0.141.0 (the module's minimum) and with the newest Hugo tested (HUGO_NEWEST, hugo.mjs), each
 *     against this checkout (HUGO_MODULE_REPLACEMENTS): the module mounts nothing but its own sources, and the example
 *     site renders the kit exactly as the reference does — the config block, the inline head snippet, the inline
 *     styles with the colour overrides, the first layer and the dialog in both languages, kit.js fingerprinted with a
 *     matching integrity — without a warning; every accepted colour form reaches the overrides as written;
 *   - `hugo --minify` (README, Minification): the minified head snippet, run in happy-dom over a stored choice, still
 *     reads it; its bytes and its ECMAScript version per minifier setting; a JSON precision that breaks it;
 *   - scratch sites prove the CSP nonce argument, a site's own string winning over the module's sample, the link forms,
 *     the optional parameters left out, a first-layer text of its own in blocks (one span per line) and a config value
 *     that tries to close the config block;
 *   - every check of consent-kit/params.html fails the build with its message: variant configs merged over the
 *     example's (`--config`), or a scratch site's own parameters where a key has to be missing.
 * Without one of the Hugo versions (mise) its builds are SKIPPED, loudly: a warning here, the verdict in the gate.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { transform } from "esbuild";
import { Window } from "happy-dom";
import { REPO, buildAssets, fileText, renderBanner, strings } from "../../../kit/build.mjs";
import { PREFIX, generate, yamlComment, yamlString } from "../generate.mjs";
import { HUGO_MIN, HUGO_NEWEST, HUGO_VERSIONS, hugoTool, probeHugo, runHugo } from "./hugo.mjs";

type Assets = Record<"head.js" | "kit.css" | "kit.js", string>;
type Tokens = Record<string, string>;

const ADAPTER = path.join(REPO, "adapters/hugo");
const EXAMPLE = path.join(ADAPTER, "exampleSite");
const SCRATCH = path.join(REPO, ".tmp/hugo-test");
/** The module import resolved to this checkout. */
const MODULE = { HUGO_MODULE_REPLACEMENTS: `github.com/vitabef/consent-kit -> ${REPO}` };
/** The characters a YAML 1.1 reader takes for a line break: LF, CR, NEL, LS, PS. */
const LINE_BREAKS = [0x0a, 0x0d, 0x85, 0x2028, 0x2029].map((code) => String.fromCharCode(code));
/** A JSON \u escape of a character, as Go's encoding/json writes <, > and &. */
const jsonEscape = (c: string) => "\\" + "u" + c.charCodeAt(0).toString(16).padStart(4, "0");
/** A scratch site's parameters: the required ones, no records, nothing optional. */
const BASE = ["revision = 1", 'cookie = "ck_consent"', 'endpoint = ""', 'privacyUrl = "/privacy/"', 'imprintUrl = "/imprint/"'];

describe("generated files (drift guard)", () => {
	it.each(Object.entries(generate()))("adapters/hugo/%s is the committed copy of a fresh generation (npm run build)", (rel, text) => {
		expect(readFileSync(path.join(ADAPTER, rel), "utf8")).toBe(text);
	});

	it("the banner partial turns every placeholder of the reference markup into a Hugo action: each string into its i18n id (the text into its blocks), each value into the validated parameter", () => {
		const partial = generate()["layouts/partials/consent-kit/banner.html"];
		const keys = Object.keys(strings("de")).filter((k) => k !== "_note");
		const values = ["privacyUrl", "imprintUrl", "endpoint", "site"];
		// no placeholder of the reference markup is left: {{key}} or {{key|filter}} (Go's own {{ end }} is no placeholder)
		expect(partial).not.toMatch(new RegExp(`\\{\\{\\s*(${[...keys, ...values].join("|")})\\s*(\\|[^}]*)?\\}\\}`));
		for (const key of keys.filter((k) => k !== "text")) expect(partial).toContain(`{{ i18n "${PREFIX}${key}" }}`);
		for (const key of values) expect(partial).toContain(`{{ $ck.${key} }}`);
	});

	it("the first-layer text: one span per line of the string, its ends trimmed, empty lines left out, joined by one space — escaped by html/template (no safeHTML)", () => {
		const partial = generate()["layouts/partials/consent-kit/banner.html"];
		expect(partial).toContain(
			'<p class="ck-cc-p">{{ $textShown := false }}{{ range split (i18n "consentKit_text") "\\n" }}{{ with trim . " \\t\\r" }}' +
				'{{ if $textShown }} {{ end }}{{ $textShown = true }}<span class="ck-cc-s">{{ . }}</span>{{ end }}{{ end }}</p>',
		);
		expect(partial).not.toContain(`{{ i18n "${PREFIX}text" }}`);
		expect(partial).not.toMatch(/safeHTML|htmlUnescape/);
	});

	it(`the module's minimum Hugo (hugo.toml) is the oldest version the build tests run with: ${HUGO_MIN}`, () => {
		expect(readFileSync(path.join(REPO, "hugo.toml"), "utf8")).toContain(`min = "${HUGO_MIN}"`);
		expect(HUGO_VERSIONS).toEqual([HUGO_MIN, HUGO_NEWEST]);
	});

	it(`the README and the gate name the two versions tested: ${HUGO_MIN} and ${HUGO_NEWEST}`, () => {
		expect(readFileSync(path.join(ADAPTER, "README.md"), "utf8")).toContain(`tested with ${HUGO_MIN} and ${HUGO_NEWEST}`);
		expect(readFileSync(path.join(REPO, "scripts/pre-push-gate.sh"), "utf8")).toContain(`${HUGO_MIN} and ${HUGO_NEWEST}`);
	});
});

describe("the YAML of the generated i18n files", () => {
	it.each(LINE_BREAKS.map((c): [string, string] => [`U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`, c]))(
		"a comment with a line break (%s) is an error: the rest of it would be read as YAML",
		(_name, c) => {
			expect(() => yamlComment(`one${c}two`, "a note")).toThrow("a note: a line break in a YAML comment");
		},
	);

	it("a value keeps every character on its line: NEL, LS and PS escaped as JSON escapes LF and CR", () => {
		const value = `a${LINE_BREAKS.join("b")}c`;
		const yaml = yamlString(value, "a value");
		for (const c of LINE_BREAKS) expect(yaml).not.toContain(c);
		expect(JSON.parse(yaml)).toBe(value); // a double-quoted YAML scalar of JSON's escapes only
	});
});

const HUGOS = HUGO_VERSIONS.map((version) => ({ version, probe: probeHugo(version) }));
for (const { version, probe } of HUGOS) {
	if (!probe.ok) console.warn(`\nSKIPPED: the Hugo build tests with Hugo ${version} need ${hugoTool(version)} (mise): ${probe.reason}\n`);
}

/** Builds the site at `source` with Hugo `version` into .tmp/hugo-test/<version>/<name>; `extra` is a config merged
 *  over the site's hugo.toml, `flags` are more command-line flags (--minify). */
function build(version: string, name: string, source: string, extra?: string, flags: string[] = []) {
	const root = path.join(SCRATCH, version);
	const dest = path.join(root, name);
	rmSync(dest, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	const args = ["-s", source, "-d", dest, "--noBuildLock", "--cacheDir", path.join(root, "cache"), ...flags];
	if (extra !== undefined) {
		const file = path.join(root, `${name}.toml`);
		writeFileSync(file, extra);
		args.push("--config", `${path.join(source, "hugo.toml")},${file}`);
	}
	const run = runHugo(version, args, MODULE);
	return { dest, status: run.status, log: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

/** A scratch site at .tmp/hugo-test/<version>/<name>-site, English only, importing the module: `params` are the lines
 *  of its [params.consentKit] table (null: no such table); its home page calls the three partials — with
 *  (dict "nonce" …) when `nonce` is given; `i18n` is its own i18n/en.yaml. */
function scratchSite(version: string, name: string, params: string[] | null, opts: { nonce?: string; i18n?: string } = {}) {
	const site = path.join(SCRATCH, version, `${name}-site`);
	rmSync(site, { recursive: true, force: true });
	mkdirSync(path.join(site, "layouts"), { recursive: true });
	const config = [
		'baseURL = "https://www.example.com/"',
		'defaultContentLanguage = "en"',
		'disableKinds = ["page", "section", "taxonomy", "term", "rss", "sitemap", "robotstxt", "404"]',
		"[[module.imports]]",
		'  path = "github.com/vitabef/consent-kit"',
		...(params === null ? [] : ["[params.consentKit]", ...params.map((line) => `  ${line}`)]),
	];
	writeFileSync(path.join(site, "hugo.toml"), config.join("\n") + "\n");
	const context = opts.nonce === undefined ? "." : `(dict "nonce" "${opts.nonce}")`;
	writeFileSync(
		path.join(site, "layouts", "index.html"),
		`<!doctype html><html lang="en"><head>{{ partial "consent-kit/head.html" ${context} }}</head>` +
			`<body>{{ partial "consent-kit/banner.html" . }}{{ partial "consent-kit/script.html" ${context} }}</body></html>\n`,
	);
	if (opts.i18n !== undefined) {
		mkdirSync(path.join(site, "i18n"), { recursive: true });
		writeFileSync(path.join(site, "i18n", "en.yaml"), opts.i18n);
	}
	return site;
}

/** Markup compared as structure: html/template's numeric entities spelled as the reference renderer spells
 *  them, whitespace runs collapsed, none between tags. */
const normalize = (html: string) =>
	html.replace(/&#34;/g, "&quot;").replace(/&#39;/g, "'").replace(/&#43;/g, "+").replace(/\s+/g, " ").replace(/> </g, "><").trim();

/** The first layer and the dialog of a page (exactly one each). */
function banner(html: string) {
	expect(html.split("data-ck-banner").length, "one first layer").toBe(2);
	expect(html.split("<dialog").length, "one dialog").toBe(2);
	return html.slice(html.indexOf('<div class="ck-cc"'), html.indexOf("</dialog>") + "</dialog>".length);
}

/** The config block's text — its attributes quoted, or not (minified). */
function configText(html: string) {
	const text = html.match(/<script\b[^>]*\bid="?ck-config"?[^>]*>([\s\S]*?)<\/script>/)?.[1];
	expect(text, "the config block").toBeDefined();
	return text ?? "";
}

/** The parsed config block of a page: HTML-escaped JSON, no "<" in it. */
function config(html: string): unknown {
	const json = configText(html);
	expect(json).not.toContain("<");
	return JSON.parse(json || "null");
}

/** The colour overrides consent-kit/params.html writes after kit.css: light, then dark (data-bs-theme, then
 *  prefers-color-scheme) — the tokens of a theme in key order. */
function overrides(light: Tokens, dark: Tokens) {
	const declarations = (tokens: Tokens) =>
		Object.keys(tokens)
			.sort()
			.map((token) => `--ck-cc-${token}:${tokens[token]};`)
			.join("");
	return (
		`.ck-cc,.ck-cd{${declarations(light)}}` +
		`[data-bs-theme="dark"] .ck-cc,[data-bs-theme="dark"] .ck-cd{${declarations(dark)}}` +
		`@media (prefers-color-scheme:dark){:root:not([data-bs-theme="light"]) .ck-cc,:root:not([data-bs-theme="light"]) .ck-cd{${declarations(dark)}}}`
	);
}

/** `use` on a page parsed into a happy-dom window: no script of it runs, nothing loads. */
async function inWindow<T>(html: string, use: (window: Window) => T): Promise<T> {
	const window = new Window({
		url: "https://www.example.com/",
		settings: {
			disableJavaScriptEvaluation: true,
			disableJavaScriptFileLoading: true,
			disableCSSFileLoading: true,
			navigation: { disableMainFrameNavigation: true },
		},
	});
	try {
		window.document.write(html);
		return use(window);
	} finally {
		await window.happyDOM.close();
	}
}

/** The page's head snippet: the <script> right after the config block. */
function headSnippet(window: Window) {
	const element = window.document.getElementById("ck-config")?.nextElementSibling;
	expect(element?.tagName, "the head snippet, right after the config block").toBe("SCRIPT");
	return element?.textContent ?? "";
}

/** Runs the page's head snippet over a stored choice, as a browser runs it in <head>: what consentKit.get() then
 *  answers, what it pushed to the dataLayer, the classes of <html>. */
function runHeadSnippet(window: Window, choice: object) {
	window.document.cookie = `ck_consent=${encodeURIComponent(JSON.stringify(choice))}; Path=/`;
	new Function("window", "document", headSnippet(window))(window, window.document);
	const w = window as unknown as { consentKit?: { get(): unknown }; dataLayer?: ArrayLike<unknown>[] };
	return {
		get: w.consentKit?.get(),
		dataLayer: (w.dataLayer ?? []).map((args) => Array.from(args)),
		classes: window.document.documentElement.className,
	};
}

/** Whether a script is ES2017: esbuild prints it the same for es2017 as for esnext — it has nothing to lower. */
async function isES2017(code: string) {
	const print = async (target: string) => (await transform(code, { loader: "js", target })).code;
	return (await print("es2017")) === (await print("esnext"));
}

for (const { version, probe } of HUGOS) {
	describe.skipIf(!probe.ok)(`the example site, built with Hugo ${version} against this checkout`, () => {
		/** exampleSite/hugo.toml: the config block it yields, the markup values per language, the colour overrides. */
		const CONFIG = {
			revision: 1,
			cookie: "ck_consent",
			domain: "example.com",
			categories: { analytics: "analytics", marketing: "marketing" },
			cleanup: { analytics: { cookies: ["_ga", "_ga_*"] }, marketing: { cookies: ["_gcl_*"], localStorage: ["_gcl_ls"] } },
			legacy: ["previous-tool-consent"],
		};
		const RECORDS = { endpoint: "https://consent.example.com/v1/record", site: "example-site" };
		const VALUES = {
			de: { privacyUrl: "#datenschutz", imprintUrl: "#impressum", ...RECORDS },
			en: { privacyUrl: "#privacy", imprintUrl: "#imprint", ...RECORDS },
		};
		const OVERRIDES = overrides({ accent: "#0b5394" }, { accent: "#9fc5e8" });
		const LANGS = ["de", "en"] as const;

		let assets: Assets;
		let dest = "";
		let log = "";
		/** The home page of a language: DE (the default language) at the root, EN under /en/. */
		const page = (lang: (typeof LANGS)[number]) => readFileSync(path.join(dest, lang === "de" ? "index.html" : "en/index.html"), "utf8");

		beforeAll(async () => {
			assets = await buildAssets();
			const run = build(version, "example", EXAMPLE);
			expect(run.status, run.log).toBe(0);
			dest = run.dest;
			log = run.log;
		}, 120000);

		it("builds without a warning (a deprecation in the module's partials would show here)", () => {
			expect(log).not.toMatch(/\bWARN/);
		});

		it("the module mounts its partials, its strings, dist/ and its empty npm manifest: nothing else of the repository reaches a site", () => {
			const run = runHugo(version, ["config", "mounts", "-s", EXAMPLE, "--cacheDir", path.join(SCRATCH, version, "cache")], MODULE);
			expect(run.status, run.stderr).toBe(0);
			// one JSON object per module, one after the other
			const modules = JSON.parse(`[${run.stdout.trim().replace(/\}\s*\{/g, "},{")}]`) as { dir: string; mounts: unknown }[];
			expect(modules.find((m) => path.resolve(m.dir) === REPO)?.mounts).toEqual([
				{ source: "adapters/hugo/layouts", target: "layouts" },
				{ source: "adapters/hugo/i18n", target: "i18n" },
				{ source: "dist", target: "assets/consent-kit" },
				{ source: "adapters/hugo/package.hugo.json", target: "assets/_jsconfig/package.hugo.json" },
			]);
			expect(JSON.parse(readFileSync(path.join(ADAPTER, "package.hugo.json"), "utf8"))).toEqual({ dependencies: {}, devDependencies: {} });
		});

		it.each(LANGS)("%s: the config block carries site.Params.consentKit as HTML-escaped JSON, in the kit's own key spelling", (lang) => {
			expect(config(page(lang))).toEqual(CONFIG);
		});

		it.each(LANGS)("%s: <head> holds, in this order, the Consent Mode defaults, the config block, the inline head snippet and the inline styles followed by the colour overrides", (lang) => {
			const html = page(lang);
			const head = html.slice(0, html.indexOf("</head>"));
			const order = [
				head.indexOf('gtag("consent", "default"'),
				head.indexOf('<script type="application/json" id="ck-config"'),
				head.indexOf(`<script data-cfasync="false">${assets["head.js"]}</script>`),
				head.indexOf(`<style>${assets["kit.css"]}${OVERRIDES}</style>`),
			];
			expect(order.every((i) => i > 0), JSON.stringify(order)).toBe(true);
			expect([...order].sort((a, b) => a - b)).toEqual(order);
		});

		it.each(LANGS)("%s: the first layer and the dialog, first in <body>, are the reference markup rendered with the language's sample strings and the site's values", (lang) => {
			const html = page(lang);
			expect(html).toContain(`<html lang="${lang}">`);
			expect(html).toMatch(/<body>\s*<div class="ck-cc" role="region"/);
			expect(normalize(banner(html))).toBe(normalize(renderBanner(lang, VALUES[lang])));
		});

		it.each(LANGS)("%s: kit.js comes last in <body>: fingerprinted, deferred, with the integrity of the published file", (lang) => {
			const html = page(lang);
			const m = html.match(/<script data-cfasync="false" src="(\/consent-kit\/kit\.([0-9a-f]{64})\.js)" integrity="([^"]+)" defer><\/script>\s*<\/body>/);
			expect(m, "the kit.js tag before </body>").not.toBeNull();
			const [, src = "", hash = "", integrity = ""] = m ?? [];
			const file = path.join(dest, src);
			expect(readFileSync(file, "utf8")).toBe(fileText(assets["kit.js"]));
			expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe(hash);
			expect(integrity.replace(/&#43;/g, "+")).toBe(`sha256-${createHash("sha256").update(readFileSync(file)).digest("base64")}`);
		});

		it.each(LANGS)('%s: every <script> carries data-cfasync="false"', (lang) => {
			const tags = page(lang).match(/<script\b[^>]*>/g) ?? [];
			expect(tags).toHaveLength(4); // the site's defaults, the config block, the head snippet, kit.js
			for (const tag of tags) expect(tag).toContain('data-cfasync="false"');
		});

		it("every accepted colour form reaches the overrides as written: #hex of 3, 4 or 8 digits (6: the example's own), a colour name, each colour function", () => {
			const LIGHT = {
				bg: "#fff",
				fg: "rebeccapurple",
				line: "#DEE2E6CC",
				accent: "color(display-p3 0.04 0.33 0.58)",
				wash: "rgb(29 65 99 / 0.1)",
				off: "rgba(108, 117, 125, 1)",
				shade: "hsl(210deg 11% 15% / 16%)",
			};
			const DARK = {
				bg: "#2b3a",
				fg: "hsla(210, 16%, 93%, 1)",
				line: "hwb(210 29% 69%)",
				accent: "lab(65% -5 -28)",
				wash: "lch(66% 30 250 / 14%)",
				off: "oklab(0.68 -0.01 -0.02)",
				shade: "oklch(0 0 none / 0.45)",
			};
			const table = (theme: string, tokens: Tokens) => [`[params.consentKit.colors.${theme}]`, ...Object.entries(tokens).map(([k, v]) => `${k} = "${v}"`)].join("\n");
			const run = build(version, "colours", EXAMPLE, `${table("light", LIGHT)}\n${table("dark", DARK)}\n`);
			expect(run.status, run.log).toBe(0);
			expect(readFileSync(path.join(run.dest, "index.html"), "utf8")).toContain(`<style>${assets["kit.css"]}${overrides(LIGHT, DARK)}</style>`);
		});

		describe("a scratch site: the nonce argument, a site's own string, the link forms, the optional parameters left out", () => {
			let html = "";

			beforeAll(() => {
				const site = scratchSite(
					version,
					"scratch",
					[
						"revision = 7",
						'cookie = "site_consent"',
						'endpoint = ""',
						'privacyUrl = "/datenschutzerklärung/"',
						'imprintUrl = "https://www.example.com/imprint/"',
						"[params.consentKit.categories]",
						'analytics = "stats"',
					],
					{ nonce: "n0nce", i18n: `${PREFIX}acceptAll: "Allow all"\n` },
				);
				const run = build(version, "scratch", site);
				expect(run.status, run.log).toBe(0);
				html = readFileSync(path.join(run.dest, "index.html"), "utf8");
			}, 120000);

			it("the nonce goes on the head snippet, the <style> and kit.js — not on the config block, a data block", () => {
				expect(html).toContain(`<script data-cfasync="false" nonce="n0nce">${assets["head.js"]}</script>`);
				expect(html).toContain(`<style nonce="n0nce">${assets["kit.css"]}</style>`);
				expect(html).toMatch(/<script data-cfasync="false" src="\/consent-kit\/kit\.[0-9a-f]{64}\.js" integrity="[^"]+" nonce="n0nce" defer><\/script>/);
				expect(html).toContain('<script type="application/json" id="ck-config" data-cfasync="false">');
			});

			it("a site's own i18n entry wins over the module's sample; the other strings stay the samples", () => {
				const s = { ...(strings("en") as Record<string, string>), acceptAll: "Allow all" };
				expect(banner(html).match(/>Allow all<\/button>/g)).toHaveLength(2);
				expect(normalize(banner(html))).toBe(
					normalize(
						renderBanner("en", { privacyUrl: "/datenschutzerkl%c3%a4rung/", imprintUrl: "https://www.example.com/imprint/", endpoint: "", site: "" }).replace(
							/>Accept all</g,
							`>${s.acceptAll}<`,
						),
					),
				);
			});

			it("the links of both layers: a path and an https URL, written URL-normalised by html/template (ä as %c3%a4)", () => {
				expect(html.match(/href="\/datenschutzerkl%c3%a4rung\/"/g)).toHaveLength(2);
				expect(html.match(/href="https:\/\/www\.example\.com\/imprint\/"/g)).toHaveLength(2);
			});

			it("the optional parameters left out: no domain, cleanup or legacy; the categories default per category; no colour overrides; no records", () => {
				expect(config(html)).toEqual({ revision: 7, cookie: "site_consent", categories: { analytics: "stats", marketing: "marketing" } });
				expect(banner(html)).toContain('data-endpoint="" data-site=""');
			});
		});

		describe("a scratch site: a text of its own in three parts (consentKit_text with line breaks)", () => {
			/** Three parts, an empty and a blank line between them, CRLF, spaces and tabs at the ends, HTML in the first. */
			const TEXT = '  First <b>part</b> & "quotes" it\'s 1+1 \r\n\n \t \nSecond part\t\nThird part, the last\n';
			/** The paragraph's text as a browser reads it: the parts, one space between them. */
			const PROSE = "First <b>part</b> & \"quotes\" it's 1+1 Second part Third part, the last";
			let html = "";
			let minified = "";

			beforeAll(() => {
				const site = scratchSite(version, "blocks", BASE, { i18n: `${PREFIX}text: ${yamlString(TEXT, "the test text")}\n` });
				const run = build(version, "blocks", site);
				expect(run.status, run.log).toBe(0);
				html = readFileSync(path.join(run.dest, "index.html"), "utf8");
				const small = build(version, "blocks-minify", site, undefined, ["--minify"]);
				expect(small.status, small.log).toBe(0);
				minified = readFileSync(path.join(small.dest, "index.html"), "utf8");
			}, 120000);

			it("one span per non-empty line inside the one paragraph, joined by one space, each part escaped by html/template", () => {
				const p = html.match(/<p class="ck-cc-p">[\s\S]*?<\/p>/g) ?? [];
				expect(p).toHaveLength(1);
				expect(p[0]).toBe(
					'<p class="ck-cc-p"><span class="ck-cc-s">First &lt;b&gt;part&lt;/b&gt; &amp; &#34;quotes&#34; it&#39;s 1&#43;1</span> ' +
						'<span class="ck-cc-s">Second part</span> <span class="ck-cc-s">Third part, the last</span></p>',
				);
			});

			it("the first layer and the dialog are the reference markup rendered with that text", () => {
				expect(normalize(banner(html))).toBe(normalize(renderBanner("en", { privacyUrl: "/privacy/", imprintUrl: "/imprint/", endpoint: "", site: "", text: TEXT })));
			});

			it.each([
				["built", () => html],
				["built with --minify", () => minified],
			])("%s: the one space between the spans survives — the paragraph's textContent keeps a space between the parts", async (_label, page) => {
				const markup = page();
				expect(markup.match(/<\/span> <span\b/g)).toHaveLength(2);
				const read = await inWindow(markup, (w) => {
					const p = w.document.querySelectorAll(".ck-cc-p");
					return { count: p.length, spans: p[0]?.querySelectorAll(".ck-cc-s").length, text: p[0]?.textContent };
				});
				expect(read).toEqual({ count: 1, spans: 3, text: PROSE });
			});
		});

		describe("a scratch site: a config value that tries to close the config block", () => {
			/** Two localStorage keys of a cleanup rule — the one config value whose check lets "<" through. */
			const HOSTILE = ["</script><script>alert(1)</script>", "a&b>c<!--"];
			const pages: Record<string, string> = {};

			beforeAll(() => {
				const site = scratchSite(version, "escape", [...BASE, "[params.consentKit.cleanup.marketing]", `localStorage = ${JSON.stringify(HOSTILE)}`]);
				for (const [variant, flags] of [
					["plain", []],
					["minify", ["--minify"]],
				] as const) {
					const run = build(version, `escape-${variant}`, site, undefined, [...flags]);
					expect(run.status, run.log).toBe(0);
					pages[variant] = readFileSync(path.join(run.dest, "index.html"), "utf8");
				}
			}, 120000);

			it.each(["plain", "minify"])("%s: three <script> elements; the config block escapes each <, > and & of the value, and parses back to it", (variant) => {
				const html = pages[variant] ?? "";
				expect(html.match(/<script\b/gi)).toHaveLength(3); // the config block, the head snippet, kit.js
				const block = configText(html);
				const count = (c: string) => block.split(jsonEscape(c)).length - 1;
				expect([count("<"), count(">"), count("&")]).toEqual([4, 4, 1]);
				expect(block).not.toMatch(/[<>&]/);
				expect((JSON.parse(block) as { cleanup: { marketing: { localStorage: string[] } } }).cleanup.marketing.localStorage).toEqual(HOSTILE);
			});
		});

		describe("hugo --minify (README, Minification): the example site with revision 123456, digits a JSON precision cuts", () => {
			const REVISION = 123456;
			/** A stored choice of that revision: analytics granted, marketing denied. */
			const CHOICE = { v: REVISION, a: 1, m: 0, t: 1700000000 };
			const GRANTED = {
				get: { analytics: true, marketing: false, decided: true, revision: REVISION },
				dataLayer: [["consent", "update", { analytics_storage: "granted", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" }]],
				classes: "ck-decided",
			};
			/** The minifier settings: the default, the README's two, and a broken one. */
			const MINIFY = {
				default: "",
				es2017: "[minify.tdewolff.js]\nversion = 2017\n",
				untouched: "[minify]\ndisableJS = true\ndisableCSS = true\n",
				jsonPrecision: "[minify.tdewolff.json]\nprecision = 1\n",
			};
			type Variant = keyof typeof MINIFY;
			const built: Partial<Record<Variant, { html: string; dest: string }>> = {};
			const html = (variant: Variant) => built[variant]?.html ?? "";

			beforeAll(() => {
				for (const variant of Object.keys(MINIFY) as Variant[]) {
					const run = build(version, `minify-${variant}`, EXAMPLE, `[params.consentKit]\nrevision = ${REVISION}\n${MINIFY[variant]}`, ["--minify"]);
					expect(run.status, run.log).toBe(0);
					built[variant] = { html: readFileSync(path.join(run.dest, "index.html"), "utf8"), dest: run.dest };
				}
			}, 120000);

			it("the shipped head snippet is ES2017 (the check's control)", async () => {
				expect(await isES2017(assets["head.js"])).toBe(true);
			});

			it("by default the head snippet is minified again — other bytes than dist/head.js, ES2019 syntax (catch{}) — and still reads the stored choice", async () => {
				const snippet = await inWindow(html("default"), headSnippet);
				expect(snippet).not.toBe(assets["head.js"]);
				expect(snippet).toContain("catch{");
				expect(await isES2017(snippet)).toBe(false);
				expect(await inWindow(html("default"), (w) => runHeadSnippet(w, CHOICE))).toEqual(GRANTED);
				expect(config(html("default"))).toEqual({ ...CONFIG, revision: REVISION }); // the config block: the same JSON
			});

			it("by default the inline styles are minified again as well; kit.js, a file of its own, is published as built — its integrity holds", async () => {
				expect(html("default")).not.toContain(assets["kit.css"]);
				const { src, integrity } = await inWindow(html("default"), (w) => {
					const tag = w.document.querySelector('script[src^="/consent-kit/kit."]');
					return { src: tag?.getAttribute("src") ?? "", integrity: tag?.getAttribute("integrity") ?? "" };
				});
				const file = path.join(built.default?.dest ?? "", src);
				expect(readFileSync(file, "utf8")).toBe(fileText(assets["kit.js"]));
				expect(integrity).toBe(`sha256-${createHash("sha256").update(readFileSync(file)).digest("base64")}`);
			});

			it("[minify.tdewolff.js] version = 2017 keeps the head snippet ES2017 (catch(e){}), and it still reads the stored choice", async () => {
				const snippet = await inWindow(html("es2017"), headSnippet);
				expect(snippet).not.toBe(assets["head.js"]);
				expect(await isES2017(snippet)).toBe(true);
				expect(await inWindow(html("es2017"), (w) => runHeadSnippet(w, CHOICE))).toEqual(GRANTED);
			});

			it("[minify] disableJS and disableCSS leave the head snippet and the styles byte for byte as shipped: a CSP hash of them holds", async () => {
				expect(await inWindow(html("untouched"), headSnippet)).toBe(assets["head.js"]);
				expect(html("untouched")).toContain(`<style>${assets["kit.css"]}${OVERRIDES}</style>`);
				expect(await inWindow(html("untouched"), (w) => runHeadSnippet(w, CHOICE))).toEqual(GRANTED);
			});

			it("[minify.tdewolff.json] precision = 1 writes the config block's revision 123456 as 1e5: the stored choice no longer counts (README: leave it at 0)", async () => {
				expect(configText(html("jsonPrecision"))).toContain('"revision":1e5');
				expect(await inWindow(html("jsonPrecision"), (w) => runHeadSnippet(w, CHOICE))).toEqual({
					get: { analytics: false, marketing: false, decided: false, revision: 100000 },
					dataLayer: [],
					classes: "",
				});
			});
		});

		it.each([
			["revision-zero", "revision 0", "[params.consentKit]\nrevision = 0\n", "site.Params.consentKit.revision must be an integer from 1 to 1000000, not 0 (int64)"],
			["revision-string", "a revision as a string", '[params.consentKit]\nrevision = "1"\n', "site.Params.consentKit.revision must be an integer from 1 to 1000000, not 1 (string)"],
			["revision-float", "a revision with a fraction", "[params.consentKit]\nrevision = 1.5\n", "site.Params.consentKit.revision must be an integer from 1 to 1000000, not 1.5 (float64)"],
			["cookie-space", "a cookie name with a space", '[params.consentKit]\ncookie = "ck consent"\n', "site.Params.consentKit.cookie must be a cookie name"],
			[
				"domain-scheme",
				"a domain with a scheme",
				'[params.consentKit]\ndomain = "https://example.com"\n',
				'site.Params.consentKit.domain must be a lower-case domain such as "example.com" (no scheme, port or leading dot), not "https://example.com" (string)',
			],
			["domain-false", "a domain of the wrong type", "[params.consentKit]\ndomain = false\n", 'site.Params.consentKit.domain must be a lower-case domain such as "example.com" (no scheme, port or leading dot), not false (bool)'],
			["endpoint-http", "an http endpoint", '[params.consentKit]\nendpoint = "http://consent.example.com/v1/record"\n', "site.Params.consentKit.endpoint must be an https URL"],
			["site-space", "a site id with a space", '[params.consentKit]\nsite = "example site"\n', 'site.Params.consentKit.site must be a site id (letters, digits, "_", ".", "-"), not "example site" (string)'],
			["site-false", "a site id of the wrong type", "[params.consentKit]\nsite = false\n", 'site.Params.consentKit.site must be a site id (letters, digits, "_", ".", "-"), not false (bool)'],
			[
				"privacy-javascript",
				"a javascript: privacy link (html/template would write #ZgotmplZ)",
				'[languages.de.params.consentKit]\nprivacyUrl = "javascript:alert(1)"\n',
				'site.Params.consentKit.privacyUrl must be an https:// URL, a path that starts with one "/" or a #fragment, not "javascript:alert(1)" (the language "de")',
			],
			[
				"imprint-tel",
				"a tel: imprint link",
				'[languages.en.params.consentKit]\nimprintUrl = "tel:+15550100"\n',
				'site.Params.consentKit.imprintUrl must be an https:// URL, a path that starts with one "/" or a #fragment, not "tel:+15550100" (the language "en")',
			],
			[
				"privacy-protocol-relative",
				"a protocol-relative privacy link (another host)",
				'[languages.de.params.consentKit]\nprivacyUrl = "//evil.example/x"\n',
				'site.Params.consentKit.privacyUrl must be an https:// URL, a path that starts with one "/" or a #fragment, not "//evil.example/x" (the language "de")',
			],
			[
				"imprint-backslash",
				"an imprint link that starts with /\\ (another host, to a browser)",
				"[languages.de.params.consentKit]\nimprintUrl = '/\\evil.example/x'\n",
				'site.Params.consentKit.imprintUrl must be an https:// URL, a path that starts with one "/" or a #fragment, not "/\\\\evil.example/x" (the language "de")',
			],
			[
				"privacy-http",
				"an http privacy link",
				'[languages.en.params.consentKit]\nprivacyUrl = "http://www.example.com/privacy/"\n',
				'site.Params.consentKit.privacyUrl must be an https:// URL, a path that starts with one "/" or a #fragment, not "http://www.example.com/privacy/" (the language "en")',
			],
			[
				"imprint-relative",
				"a relative imprint link",
				'[languages.de.params.consentKit]\nimprintUrl = "impressum.html"\n',
				'site.Params.consentKit.imprintUrl must be an https:// URL, a path that starts with one "/" or a #fragment, not "impressum.html" (the language "de")',
			],
			[
				"privacy-space",
				"a privacy link with a space",
				'[languages.en.params.consentKit]\nprivacyUrl = "/privacy policy/"\n',
				'site.Params.consentKit.privacyUrl must be an https:// URL, a path that starts with one "/" or a #fragment, not "/privacy policy/" (the language "en")',
			],
			[
				"privacy-bare-hash",
				"a bare # as the privacy link",
				'[languages.de.params.consentKit]\nprivacyUrl = "#"\n',
				'site.Params.consentKit.privacyUrl must be an https:// URL, a path that starts with one "/" or a #fragment, not "#" (the language "de")',
			],
			[
				"privacy-fragment-colon",
				"a fragment with a colon (html/template would read #abschnitt as a scheme and write #ZgotmplZ)",
				'[languages.de.params.consentKit]\nprivacyUrl = "#abschnitt:1"\n',
				'site.Params.consentKit.privacyUrl must be an https:// URL, a path that starts with one "/" or a #fragment, not "#abschnitt:1" (the language "de")',
			],
			["privacy-empty", "an empty privacy link", '[languages.de.params.consentKit]\nprivacyUrl = ""\n', 'site.Params.consentKit.privacyUrl must be set for the language "de"'],
			["legacy-name", "a legacy cookie name with a space", '[params.consentKit]\nlegacy = ["previous tool"]\n', "site.Params.consentKit.legacy: previous tool is not a cookie name"],
			["legacy-string", "legacy of the wrong type", '[params.consentKit]\nlegacy = ""\n', 'site.Params.consentKit.legacy must be a list of cookie names, not "" (string)'],
			["categories-unknown", "an unknown category", '[params.consentKit.categories]\nads = "ads"\n', "site.Params.consentKit.categories.ads is not a category (analytics, marketing)"],
			[
				"categories-value",
				"a data-consent value with a space",
				'[params.consentKit.categories]\nanalytics = "web stats"\n',
				'site.Params.consentKit.categories.analytics must be a data-consent value (letters, digits, "_", "-"), not web stats',
			],
			["categories-zero", "categories of the wrong type", "[params.consentKit]\ncategories = 0\n", "site.Params.consentKit.categories must be a table (analytics, marketing), not 0 (int64)"],
			["cleanup-unknown", "an unknown cleanup category", '[params.consentKit.cleanup.ads]\ncookies = ["_ads"]\n', "site.Params.consentKit.cleanup.ads is not a category (analytics, marketing)"],
			["cleanup-rule", "a cleanup rule that is not a table", '[params.consentKit.cleanup]\nanalytics = "_ga"\n', "site.Params.consentKit.cleanup.analytics must be a table: cookies, localStorage"],
			["cleanup-key", "an unknown key in a cleanup rule", '[params.consentKit.cleanup.analytics]\nfiles = ["_ga"]\n', "site.Params.consentKit.cleanup.analytics.files is not a parameter (cookies, localStorage)"],
			["cleanup-list", "cleanup cookies as a string, not a list", '[params.consentKit.cleanup.analytics]\ncookies = "_ga"\n', "site.Params.consentKit.cleanup.analytics.cookies must be a list"],
			["cleanup-number", "a cleanup cookie that is a number", "[params.consentKit.cleanup.analytics]\ncookies = [1]\n", "site.Params.consentKit.cleanup.analytics.cookies: 1 is not a string"],
			["cleanup-empty-key", "an empty localStorage key", '[params.consentKit.cleanup.marketing]\nlocalStorage = [""]\n', "site.Params.consentKit.cleanup.marketing.localStorage: an empty key"],
			[
				"cleanup-cookie",
				"a cleanup cookie with a * inside",
				'[params.consentKit.cleanup.analytics]\ncookies = ["_g*a"]\n',
				'site.Params.consentKit.cleanup.analytics.cookies: "_g*a" is not a cookie name or a prefix ending in "*"',
			],
			["cleanup-false", "cleanup of the wrong type", "[params.consentKit]\ncleanup = false\n", "site.Params.consentKit.cleanup must be a table (analytics, marketing), not false (bool)"],
			["colour-rule", "a colour that would close the rule", '[params.consentKit.colors.light]\naccent = "red}body{display:none"\n', "site.Params.consentKit.colors.light.accent must be a CSS colour"],
			["colour-unclosed", "a colour function left open (it would swallow the next declarations)", '[params.consentKit.colors.light]\naccent = "rgb(0 0 0"\n', "site.Params.consentKit.colors.light.accent must be a CSS colour"],
			["colour-url", "a url() (a request before consent)", '[params.consentKit.colors.light]\nbg = "url(//evil.example/x)"\n', "site.Params.consentKit.colors.light.bg must be a CSS colour"],
			["colour-var", "a var()", '[params.consentKit.colors.dark]\nfg = "var(--ck-cc-bg)"\n', "site.Params.consentKit.colors.dark.fg must be a CSS colour"],
			["colour-image-set", "an image-set()", "[params.consentKit.colors.dark]\nbg = 'image-set(\"x.png\" 1x)'\n", "site.Params.consentKit.colors.dark.bg must be a CSS colour"],
			["colour-nested", "a colour function with a nested function", '[params.consentKit.colors.light]\nwash = "rgb(from red r g b / calc(alpha / 2))"\n', "site.Params.consentKit.colors.light.wash must be a CSS colour"],
			["colour-hex", "a #hex of five digits", '[params.consentKit.colors.light]\nline = "#12345"\n', "site.Params.consentKit.colors.light.line must be a CSS colour"],
			["colour-theme", "an unknown theme", '[params.consentKit.colors.sepia]\naccent = "#704214"\n', "site.Params.consentKit.colors.sepia is not a theme (light, dark)"],
			["colour-theme-value", "a theme that is not a table", '[params.consentKit.colors]\nlight = "#fff"\n', "site.Params.consentKit.colors.light must be a table of colour tokens"],
			["colour-token", "an unknown colour token", '[params.consentKit.colors.light]\nbrand = "#fff"\n', "site.Params.consentKit.colors.light.brand is not a colour token (bg, fg, line, accent, wash, off, shade)"],
			["colors-false", "colors of the wrong type", "[params.consentKit]\ncolors = false\n", "site.Params.consentKit.colors must be a table (light, dark), not false (bool)"],
			["unknown-key", "a misspelt parameter", "[params.consentKit]\nrevison = 2\n", "site.Params.consentKit.revison is not a parameter"],
			[
				"no-strings",
				"a default language without the kit's strings",
				'defaultContentLanguage = "fr"\n[languages.fr]\nweight = 3\n[languages.fr.params.consentKit]\nprivacyUrl = "#p"\nimprintUrl = "#i"\n',
				'no string "consentKit_title" for the language "fr"',
			],
		])("invalid (%s): %s fails the build with the validator's message", (name, _what, extra, message) => {
			const run = build(version, `invalid-${name}`, EXAMPLE, extra);
			expect(run.status, run.log).toBe(1);
			expect(run.log).toContain(`ERROR consent-kit: ${message}`);
		});

		const MISSING: [string, string, string[] | null, string][] = [
			["no-params", "no [params.consentKit] at all", null, "site.Params.consentKit is missing"],
			["no-endpoint", "no endpoint", BASE.filter((line) => !line.startsWith("endpoint")), 'site.Params.consentKit.endpoint must be set: the records URL (https://…/v1/record), or "" for no records'],
			["no-privacy", "no privacyUrl", BASE.filter((line) => !line.startsWith("privacyUrl")), 'site.Params.consentKit.privacyUrl must be set for the language "en"'],
			["no-imprint", "no imprintUrl", BASE.filter((line) => !line.startsWith("imprintUrl")), 'site.Params.consentKit.imprintUrl must be set for the language "en"'],
			[
				"no-site",
				"an endpoint without a site id",
				[...BASE.filter((line) => !line.startsWith("endpoint")), 'endpoint = "https://consent.example.com/v1/record"'],
				"site.Params.consentKit.site is missing: the endpoint needs the site id",
			],
		];
		it.each(MISSING)("invalid scratch site (%s): %s fails the build with the validator's message", (name, _what, params, message) => {
			const run = build(version, `missing-${name}`, scratchSite(version, `missing-${name}`, params));
			expect(run.status, run.log).toBe(1);
			expect(run.log).toContain(`ERROR consent-kit: ${message}`);
		});
	});
}
