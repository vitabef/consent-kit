// @vitest-environment node
/**
 * The Hugo adapter (adapters/hugo/README.md):
 *   - its generated files are the committed copies of a fresh generation (the drift guard: `npm run build`);
 *   - built with Hugo 0.141.0 (the module's minimum) against this checkout (HUGO_MODULE_REPLACEMENTS), the module
 *     mounts nothing but its own sources, and the example site renders the kit exactly as the reference does: the
 *     config block, the inline head snippet, the inline styles with the colour overrides, the first layer and the
 *     dialog in both languages, kit.js fingerprinted with a matching integrity;
 *   - a scratch site proves the CSP nonce argument, a site's own string winning over the module's sample, the
 *     optional parameters left out; variant configs merged over the example's (`--config`) fail the build with
 *     the validator's message.
 * Without Hugo 0.141.0 extended (mise) the Hugo builds are SKIPPED, loudly: a warning here, the verdict in the gate.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO, buildAssets, fileText, renderBanner, strings } from "../../../kit/build.mjs";
import { PREFIX, generate } from "../generate.mjs";
import { HUGO_TOOL, HUGO_VERSION, probeHugo, runHugo } from "./hugo.mjs";

type Assets = Record<"head.js" | "kit.css" | "kit.js", string>;

const ADAPTER = path.join(REPO, "adapters/hugo");
const EXAMPLE = path.join(ADAPTER, "exampleSite");
const SCRATCH = path.join(REPO, ".tmp/hugo-test");
/** The module import resolved to this checkout. */
const MODULE = { HUGO_MODULE_REPLACEMENTS: `github.com/vitabef/consent-kit -> ${REPO}` };

describe("generated files (drift guard)", () => {
	it.each(Object.entries(generate()))("adapters/hugo/%s is the committed copy of a fresh generation (npm run build)", (rel, text) => {
		expect(readFileSync(path.join(ADAPTER, rel), "utf8")).toBe(text);
	});

	it("the banner partial turns every placeholder of the reference markup into a Hugo action: each string into its i18n id, each value into the validated parameter", () => {
		const partial = generate()["layouts/partials/consent-kit/banner.html"];
		expect(partial).not.toMatch(/\{\{\s*[A-Za-z]\w*\s*\}\}/);
		for (const key of Object.keys(strings("de")).filter((k) => k !== "_note")) expect(partial).toContain(`{{ i18n "${PREFIX}${key}" }}`);
		for (const key of ["privacyUrl", "imprintUrl", "endpoint", "site"]) expect(partial).toContain(`{{ $ck.${key} }}`);
	});
});

const HUGO = probeHugo();
if (!HUGO.ok) {
	console.warn(`\nSKIPPED: the Hugo build tests need Hugo ${HUGO_VERSION} extended (mise x ${HUGO_TOOL}): ${HUGO.reason}\n`);
}

/** Builds the site at `source` into .tmp/hugo-test/<name>; `extra` is a config merged over the site's hugo.toml. */
function build(name: string, source: string, extra?: string) {
	const dest = path.join(SCRATCH, name);
	rmSync(dest, { recursive: true, force: true });
	mkdirSync(SCRATCH, { recursive: true });
	const args = ["-s", source, "-d", dest, "--noBuildLock", "--cacheDir", path.join(SCRATCH, "cache")];
	if (extra !== undefined) {
		const file = path.join(SCRATCH, `${name}.toml`);
		writeFileSync(file, extra);
		args.push("--config", `${path.join(source, "hugo.toml")},${file}`);
	}
	const run = runHugo(args, MODULE);
	return { dest, status: run.status, log: `${run.stdout ?? ""}${run.stderr ?? ""}` };
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

/** The parsed config block of a page. */
function config(html: string): unknown {
	const json = html.match(/<script type="application\/json" id="ck-config" data-cfasync="false">(.*?)<\/script>/)?.[1];
	expect(json, "the config block").toBeDefined();
	expect(json).not.toContain("<");
	return JSON.parse(json ?? "null");
}

describe.skipIf(!HUGO.ok)(`the example site, built with Hugo ${HUGO_VERSION} against this checkout`, () => {
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
	const OVERRIDES =
		".ck-cc,.ck-cd{--ck-cc-accent:#0b5394;}" +
		'[data-bs-theme="dark"] .ck-cc,[data-bs-theme="dark"] .ck-cd{--ck-cc-accent:#9fc5e8;}' +
		'@media (prefers-color-scheme:dark){:root:not([data-bs-theme="light"]) .ck-cc,:root:not([data-bs-theme="light"]) .ck-cd{--ck-cc-accent:#9fc5e8;}}';
	const LANGS = ["de", "en"] as const;

	let assets: Assets;
	let dest = "";
	/** The home page of a language: DE (the default language) at the root, EN under /en/. */
	const page = (lang: (typeof LANGS)[number]) => readFileSync(path.join(dest, lang === "de" ? "index.html" : "en/index.html"), "utf8");

	beforeAll(async () => {
		assets = await buildAssets();
		const run = build("example", EXAMPLE);
		expect(run.status, run.log).toBe(0);
		dest = run.dest;
	}, 120000);

	it("the module mounts its partials, its strings, dist/ and its empty npm manifest: nothing else of the repository reaches a site", () => {
		const run = runHugo(["config", "mounts", "-s", EXAMPLE, "--cacheDir", path.join(SCRATCH, "cache")], MODULE);
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

	describe("a scratch site: the nonce argument, a site's own string, the optional parameters left out", () => {
		const SITE = path.join(SCRATCH, "scratch-site");
		let html = "";

		beforeAll(() => {
			rmSync(SITE, { recursive: true, force: true });
			mkdirSync(path.join(SITE, "layouts"), { recursive: true });
			mkdirSync(path.join(SITE, "i18n"), { recursive: true });
			writeFileSync(
				path.join(SITE, "hugo.toml"),
				[
					'baseURL = "https://www.example.com/"',
					'defaultContentLanguage = "en"',
					'disableKinds = ["page", "section", "taxonomy", "term", "rss", "sitemap", "robotstxt", "404"]',
					"[[module.imports]]",
					'  path = "github.com/vitabef/consent-kit"',
					"[params.consentKit]",
					"  revision = 7",
					'  cookie = "site_consent"',
					'  endpoint = ""',
					'  privacyUrl = "/privacy/"',
					'  imprintUrl = "/imprint/"',
					"  [params.consentKit.categories]",
					'    analytics = "stats"',
				].join("\n") + "\n",
			);
			writeFileSync(
				path.join(SITE, "layouts", "index.html"),
				'<!doctype html><html lang="en"><head>{{ partial "consent-kit/head.html" (dict "nonce" "n0nce") }}</head>' +
					'<body>{{ partial "consent-kit/banner.html" . }}{{ partial "consent-kit/script.html" (dict "nonce" "n0nce") }}</body></html>\n',
			);
			writeFileSync(path.join(SITE, "i18n", "en.yaml"), `${PREFIX}acceptAll: "Allow all"\n`);
			const run = build("scratch", SITE);
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
				normalize(renderBanner("en", { privacyUrl: "/privacy/", imprintUrl: "/imprint/", endpoint: "", site: "" }).replace(/>Accept all</g, `>${s.acceptAll}<`)),
			);
		});

		it("the optional parameters left out: no domain, cleanup or legacy; the categories default per category; no colour overrides; no records", () => {
			expect(config(html)).toEqual({ revision: 7, cookie: "site_consent", categories: { analytics: "stats", marketing: "marketing" } });
			expect(banner(html)).toContain('data-endpoint="" data-site=""');
		});
	});

	it.each([
		["revision-zero", "revision 0", "[params.consentKit]\nrevision = 0\n", "site.Params.consentKit.revision must be an integer from 1 to 1000000, not 0 (int64)"],
		["revision-string", "a revision as a string", '[params.consentKit]\nrevision = "1"\n', "site.Params.consentKit.revision must be an integer from 1 to 1000000, not 1 (string)"],
		["cookie-space", "a cookie name with a space", '[params.consentKit]\ncookie = "ck consent"\n', "site.Params.consentKit.cookie must be a cookie name"],
		["endpoint-http", "an http endpoint", '[params.consentKit]\nendpoint = "http://consent.example.com/v1/record"\n', "site.Params.consentKit.endpoint must be an https URL"],
		["colour-rule", "a colour that would close the rule", '[params.consentKit.colors.light]\naccent = "red}body{display:none"\n', "site.Params.consentKit.colors.light.accent must be a CSS colour"],
		["unknown-key", "a misspelt parameter", "[params.consentKit]\nrevison = 2\n", "site.Params.consentKit.revison is not a parameter"],
		[
			"no-strings",
			"a default language without the kit's strings",
			'defaultContentLanguage = "fr"\n[languages.fr]\nweight = 3\n[languages.fr.params.consentKit]\nprivacyUrl = "#p"\nimprintUrl = "#i"\n',
			'no string "consentKit_title" for the language "fr"',
		],
	])("invalid (%s): %s fails the build with the validator's message", (name, _what, extra, message) => {
		const run = build(`invalid-${name}`, EXAMPLE, extra);
		expect(run.status, run.log).toBe(1);
		expect(run.log).toContain(`ERROR consent-kit: ${message}`);
	});
});
