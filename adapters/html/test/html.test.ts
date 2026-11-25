// @vitest-environment node
/**
 * The HTML adapter (adapters/html/README.md):
 *   - the committed example (example/fragments/ from example/site.json) is exactly one fresh generation (the drift
 *     guard: `npm run build`);
 *   - the fragments are the kit's own: the demo's Consent Mode defaults, the config block of kit/build.mjs with every
 *     category mapped, the head snippet and the styles byte for byte as built, the reference markup rendered per
 *     language (the site's own texts included, the first-layer text in blocks), a reopen link, kit.js fingerprinted
 *     with a matching integrity; no value can close the config block or leave an attribute;
 *   - every invalid site config fails with its message; the command line writes the files and fails loudly.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO, buildAssets, configBlock, renderBanner } from "../../../kit/build.mjs";
import { CONSENT_MODE, KIT_PATH, generate } from "../generate.mjs";

type Assets = Record<"head.js" | "kit.css" | "kit.js", string>;
type Site = Record<string, unknown>;

const ADAPTER = path.join(REPO, "adapters/html");
const FRAGMENTS = path.join(ADAPTER, "example/fragments");
const SCRATCH = path.join(REPO, ".tmp/html-test");
const example = (): Site => JSON.parse(readFileSync(path.join(ADAPTER, "example/site.json"), "utf8"));
/** The example's site config with `change` merged over its top level. */
const variant = (change: Site): Site => ({ ...example(), ...change });
/** The example's languages with `change` merged over one of them. */
const language = (lang: "de" | "en", change: Site): Site => {
	const languages = example().languages as Record<string, Site>;
	return { languages: { ...languages, [lang]: { ...languages[lang], ...change } } };
};
/** The config block's JSON text in a head fragment. */
const configText = (head: string) => head.match(/^<script type="application\/json" id="ck-config">(.*)<\/script>$/m)?.[1] ?? "";

let assets: Assets;
beforeAll(async () => {
	assets = await buildAssets();
});

describe("the committed example (drift guard)", () => {
	it.each(Object.entries(generate(example())))("adapters/html/example/fragments/%s is the committed copy of a fresh generation (npm run build)", (rel, text) => {
		expect(readFileSync(path.join(FRAGMENTS, rel), "utf8")).toBe(text);
	});

	it("example/fragments/ holds that one generation and nothing else (a new kit.js is a new kit.<sha256>.js: npm run build replaces the folder)", () => {
		const files = readdirSync(FRAGMENTS, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile() && !entry.name.startsWith("."))
			.map((entry) => path.relative(FRAGMENTS, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
		expect(files.sort()).toEqual(Object.keys(generate(example())).sort());
	});
});

describe("the fragments", () => {
	const files = generate(example());
	const kitFile = Object.keys(files).find((rel) => rel.startsWith("consent-kit/")) ?? "";

	it("consent-mode.html: the demo's Consent Mode defaults (kit/README.md, Page structure), everything denied, no url_passthrough", () => {
		const demo = readFileSync(path.join(REPO, "kit/demo/index.html"), "utf8");
		const defaults = demo.match(/<script data-cfasync="false">\n {2}window\.dataLayer[\s\S]*?<\/script>\n/)?.[0];
		expect(files["consent-mode.html"]).toBe(defaults);
		expect(CONSENT_MODE).not.toContain("url_passthrough");
		for (const type of ["ad_storage", "ad_user_data", "ad_personalization", "analytics_storage"]) expect(CONSENT_MODE).toContain(`${type}: "denied"`);
	});

	it("head.html: the config block, the inline head snippet and the inline styles, in this order, byte for byte as built", () => {
		const config = {
			revision: 1,
			cookie: "ck_consent",
			domain: "example.com",
			categories: { analytics: "analytics", marketing: "marketing" },
			cleanup: { analytics: { cookies: ["_ga", "_ga_*"] }, marketing: { cookies: ["_gcl_*"], localStorage: ["_gcl_ls"] } },
			legacy: ["previous-tool-consent"],
		};
		expect(files["head.html"]).toBe(
			`${configBlock(config)}\n<script data-cfasync="false">${assets["head.js"]}</script>\n<style>${assets["kit.css"]}</style>\n`,
		);
		expect(JSON.parse(configText(files["head.html"] ?? ""))).toEqual(config);
	});

	it.each(["de", "en"] as const)("%s/banner.html: the reference markup rendered with the language's strings and the site's values", (lang) => {
		const urls = (example().languages as Record<string, Site>)[lang];
		expect(files[`${lang}/banner.html`]).toBe(
			renderBanner(lang, { privacyUrl: urls?.privacyUrl, imprintUrl: urls?.imprintUrl, endpoint: "https://consent.example.com/v1/record", site: "example-site" }),
		);
	});

	it.each([
		["de", '<a href="/datenschutz/" data-ck-open>Cookie-Einstellungen</a>\n'],
		["en", '<a href="/en/privacy/" data-ck-open>Cookie settings</a>\n'],
	])("%s/footer-link.html: the reopen link to the privacy URL, named like the dialog the first-layer text points to", (lang, link) => {
		expect(files[`${lang}/footer-link.html`]).toBe(link);
	});

	it("script.html: kit.js deferred from /consent-kit/, named by its SHA-256, with the integrity of the file it names", () => {
		const kit = readFileSync(path.join(REPO, "dist/kit.js"), "utf8");
		const sha256 = createHash("sha256").update(kit).digest();
		expect(kit).toBe(`${assets["kit.js"]}\n`);
		expect(kitFile).toBe(`consent-kit/kit.${sha256.toString("hex")}.js`);
		expect(files[kitFile]).toBe(kit);
		expect(files["script.html"]).toBe(
			`<script data-cfasync="false" src="${KIT_PATH}${kitFile.slice("consent-kit/".length)}" integrity="sha256-${sha256.toString("base64")}" defer></script>\n`,
		);
	});

	it("the site's own texts replace the samples: in both layers, the reopen link named by the own dialog title, the first-layer text in blocks", () => {
		const texts = { acceptAll: "Allow all", dialogTitle: "Privacy & cookies", text: "First part <b>\n\n  Second part\n" };
		const own = generate(variant(language("en", { texts })));
		expect(own["en/banner.html"]).toBe(
			renderBanner("en", { ...texts, privacyUrl: "/en/privacy/", imprintUrl: "/en/imprint/", endpoint: "https://consent.example.com/v1/record", site: "example-site" }),
		);
		expect(own["en/banner.html"]?.match(/>Allow all<\/button>/g)).toHaveLength(2);
		expect(own["en/banner.html"]).toContain('<p class="ck-cc-p"><span class="ck-cc-s">First part &lt;b&gt;</span> <span class="ck-cc-s">Second part</span></p>');
		expect(own["en/footer-link.html"]).toBe('<a href="/en/privacy/" data-ck-open>Privacy &amp; cookies</a>\n');
		expect(own["de/banner.html"]).toBe(files["de/banner.html"]);
	});

	it("the optional keys left out: no domain, cleanup or legacy in the config block, every category mapped to its own name; no records", () => {
		const site = { revision: 3, cookie: "site_consent", endpoint: "", languages: { en: { privacyUrl: "#privacy", imprintUrl: "https://www.example.com/imprint/" } } };
		const own = generate(site);
		expect(JSON.parse(configText(own["head.html"] ?? ""))).toEqual({ revision: 3, cookie: "site_consent", categories: { analytics: "analytics", marketing: "marketing" } });
		expect(own["en/banner.html"]).toContain('data-endpoint="" data-site=""');
		expect(Object.keys(own).filter((rel) => rel.includes("/") && !rel.startsWith("consent-kit/"))).toEqual(["en/banner.html", "en/footer-link.html"]);
	});

	it("a value cannot close the config block or leave an attribute: every < in the JSON escaped, the URLs HTML-escaped", () => {
		const hostile = ["</script><script>alert(1)</script>", "a&b>c<!--"];
		const own = generate(
			variant({ cleanup: { marketing: { localStorage: hostile } }, ...language("en", { privacyUrl: "/p/?a=1&b=2" }) }),
		);
		const head = own["head.html"] ?? "";
		expect(head.match(/<script\b/g)).toHaveLength(2); // the config block, the head snippet
		expect(configText(head)).not.toContain("<");
		expect((JSON.parse(configText(head)) as { cleanup: { marketing: { localStorage: string[] } } }).cleanup.marketing.localStorage).toEqual(hostile);
		expect(own["en/footer-link.html"]).toBe('<a href="/p/?a=1&amp;b=2" data-ck-open>Cookie settings</a>\n');
		expect(own["en/banner.html"]?.match(/href="\/p\/\?a=1&amp;b=2"/g)).toHaveLength(2);
	});
});

describe("an invalid site config fails with its message", () => {
	it.each([
		["not an object", [], "the site config must be a JSON object"],
		["a misspelt key", variant({ revison: 2 }), "revison is not a key"],
		["revision 0", variant({ revision: 0 }), "revision must be an integer from 1 to 1000000, not 0"],
		["revision as a string", variant({ revision: "1" }), 'revision must be an integer from 1 to 1000000, not "1"'],
		["a fractional revision", variant({ revision: 1.5 }), "revision must be an integer from 1 to 1000000, not 1.5"],
		["revision above 1,000,000", variant({ revision: 1000001 }), "revision must be an integer from 1 to 1000000, not 1000001"],
		["no cookie", variant({ cookie: undefined }), 'cookie must be a cookie name (letters, digits, "_", ".", "-"), not nothing'],
		["a cookie name with a space", variant({ cookie: "ck consent" }), 'cookie must be a cookie name (letters, digits, "_", ".", "-"), not "ck consent"'],
		["a domain with a scheme", variant({ domain: "https://example.com" }), 'domain must be a lower-case domain such as "example.com"'],
		["a domain with a leading dot", variant({ domain: ".example.com" }), 'domain must be a lower-case domain such as "example.com"'],
		["no endpoint", variant({ endpoint: undefined }), 'endpoint must be the records URL (https://…/v1/record), or "" for no records, not nothing'],
		["an http endpoint", variant({ endpoint: "http://consent.example.com/v1/record" }), "endpoint must be the records URL"],
		["an endpoint without a site id", variant({ site: undefined }), "site is missing: the endpoint needs the site id"],
		["a site id with a space", variant({ site: "example site" }), 'site must be a site id (letters, digits, "_", ".", "-"), not "example site"'],
		["an unknown category", variant({ categories: { ads: "ads" } }), "categories.ads is not a key (analytics, marketing)"],
		["a data-consent value with a space", variant({ categories: { analytics: "web stats" } }), 'categories.analytics must be a data-consent value (letters, digits, "_", "-"), not "web stats"'],
		[
			"two categories on one data-consent value",
			variant({ categories: { analytics: "tags", marketing: "tags" } }),
			'categories: analytics and marketing must activate different data-consent values, not both "tags"',
		],
		[
			"analytics on marketing's own name",
			variant({ categories: { analytics: "marketing" } }),
			'categories: analytics and marketing must activate different data-consent values, not both "marketing"',
		],
		["an unknown cleanup category", variant({ cleanup: { ads: { cookies: ["_ads"] } } }), "cleanup.ads is not a key (analytics, marketing)"],
		["a cleanup rule that is not an object", variant({ cleanup: { analytics: "_ga" } }), 'cleanup.analytics must be an object (cookies, localStorage), not "_ga"'],
		["an unknown key in a cleanup rule", variant({ cleanup: { analytics: { files: ["_ga"] } } }), "cleanup.analytics.files is not a key (cookies, localStorage)"],
		["cleanup cookies as a string", variant({ cleanup: { analytics: { cookies: "_ga" } } }), "cleanup.analytics.cookies must be a list"],
		["a cleanup cookie with a * inside", variant({ cleanup: { analytics: { cookies: ["_g*a"] } } }), 'cleanup.analytics.cookies: "_g*a" is not a cookie name or a prefix ending in "*"'],
		["an empty localStorage key", variant({ cleanup: { marketing: { localStorage: [""] } } }), 'cleanup.marketing.localStorage: "" is not a non-empty key'],
		[
			"a cleanup prefix that matches the choice cookie",
			variant({ cleanup: { analytics: { cookies: ["_ga", "ck_*"] } } }),
			'cleanup.analytics.cookies: "ck_*" would delete the choice cookie "ck_consent"',
		],
		[
			"a cleanup name that is the choice cookie",
			variant({ cleanup: { marketing: { cookies: ["ck_consent"] } } }),
			'cleanup.marketing.cookies: "ck_consent" would delete the choice cookie "ck_consent"',
		],
		[
			"a legacy name that is the choice cookie",
			variant({ legacy: ["previous-tool-consent", "ck_consent"] }),
			'legacy: "ck_consent" is the choice cookie, which kit.js would delete on every page load',
		],
		["a legacy name with a space", variant({ legacy: ["previous tool"] }), 'legacy: "previous tool" is not a cookie name'],
		["legacy as a string", variant({ legacy: "previous-tool-consent" }), "legacy must be a list of"],
		["no languages", variant({ languages: {} }), "languages must be an object with an entry per language (de, en)"],
		["a language without the kit's strings", variant({ languages: { fr: { privacyUrl: "/p/", imprintUrl: "/i/" } } }), "languages.fr: the kit has no strings for it (de, en)"],
		["an unknown key of a language", variant(language("de", { cookieLink: "x" })), "languages.de.cookieLink is not a key (privacyUrl, imprintUrl, texts)"],
		["a javascript: privacy link", variant(language("de", { privacyUrl: "javascript:alert(1)" })), 'languages.de.privacyUrl must be an https:// URL, a path that starts with one "/" or a #fragment, not "javascript:alert(1)"'],
		["a protocol-relative privacy link", variant(language("en", { privacyUrl: "//evil.example/x" })), 'languages.en.privacyUrl must be an https:// URL, a path that starts with one "/" or a #fragment, not "//evil.example/x"'],
		["an imprint link that starts with /\\", variant(language("de", { imprintUrl: "/\\evil.example/x" })), "languages.de.imprintUrl must be an https:// URL"],
		["an http imprint link", variant(language("en", { imprintUrl: "http://www.example.com/imprint/" })), "languages.en.imprintUrl must be an https:// URL"],
		["a relative imprint link", variant(language("de", { imprintUrl: "impressum.html" })), "languages.de.imprintUrl must be an https:// URL"],
		["a bare # as the privacy link", variant(language("de", { privacyUrl: "#" })), "languages.de.privacyUrl must be an https:// URL"],
		["no imprint link", variant(language("en", { imprintUrl: undefined })), 'languages.en.imprintUrl must be an https:// URL, a path that starts with one "/" or a #fragment, not nothing'],
		["an unknown text key", variant(language("en", { texts: { cookieLink: "x" } })), "languages.en.texts.cookieLink is not a key"],
		["the note as a text key", variant(language("en", { texts: { _note: "x" } })), "languages.en.texts._note is not a key"],
		["an empty text", variant(language("en", { texts: { acceptAll: " " } })), 'languages.en.texts.acceptAll must be a non-empty string, not " "'],
		["a text that is not a string", variant(language("de", { texts: { acceptAll: 1 } })), "languages.de.texts.acceptAll must be a non-empty string, not 1"],
	])("%s", (_what, site, message) => {
		expect(() => generate(site)).toThrow(`consent-kit: ${message}`);
	});
});

describe("the command line: node adapters/html/generate.mjs <site.json> <out-dir>", () => {
	const run = (...args: string[]) => spawnSync(process.execPath, [path.join(ADAPTER, "generate.mjs"), ...args], { encoding: "utf8" });

	it("writes every file of the generation below the output folder and lists them", () => {
		const out = path.join(SCRATCH, "out");
		rmSync(out, { recursive: true, force: true });
		const result = run(path.join(ADAPTER, "example/site.json"), out);
		expect(result.status, result.stderr).toBe(0);
		for (const [rel, text] of Object.entries(generate(example()))) {
			expect(readFileSync(path.join(out, rel), "utf8"), rel).toBe(text);
			expect(result.stdout).toContain(path.join(out, rel));
		}
	});

	it("an invalid site config exits 1 with the message and writes nothing; no arguments print the usage (exit 2)", () => {
		const out = path.join(SCRATCH, "invalid");
		const config = path.join(SCRATCH, "invalid.json");
		rmSync(out, { recursive: true, force: true });
		mkdirSync(SCRATCH, { recursive: true });
		writeFileSync(config, JSON.stringify(variant({ revision: 0 })));
		const bad = run(config, out);
		expect(bad.status).toBe(1);
		expect(bad.stderr).toContain(`consent-kit: ${config}: revision must be an integer from 1 to 1000000, not 0`);
		expect(() => readdirSync(out)).toThrow();
		const usage = run();
		expect(usage.status).toBe(2);
		expect(usage.stderr).toContain("usage: node adapters/html/generate.mjs <site.json> <out-dir>");
	});

	it.each<[string, string, string | null, string]>([
		["a missing site config", "missing.json", null, "ENOENT"],
		["a site config that is not JSON", "broken.json", '{"revision": 1,', "JSON"],
	])("%s exits 1 with consent-kit:, the file's name and the reason, and writes nothing", (_what, name, text, reason) => {
		const file = path.join(SCRATCH, name);
		const out = path.join(SCRATCH, `out-${name}`);
		rmSync(file, { force: true });
		rmSync(out, { recursive: true, force: true });
		mkdirSync(SCRATCH, { recursive: true });
		if (text !== null) writeFileSync(file, text);
		const result = run(file, out);
		expect(result.status).toBe(1);
		expect(result.stderr.startsWith(`consent-kit: ${file}: `), result.stderr).toBe(true);
		expect(result.stderr).toContain(reason);
		expect(() => readdirSync(out)).toThrow();
	});
});
