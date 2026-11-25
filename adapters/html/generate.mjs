#!/usr/bin/env node
/**
 * The HTML adapter — `node adapters/html/generate.mjs <site.json> <out-dir>`: the kit for any website, as the
 * fragments a site pastes into its pages (adapters/html/README.md). Everything comes from the kit's own sources
 * (kit/build.mjs: the reference renderer, the config block, the strings) and its committed build (dist/), so no
 * fragment can drift from the reference. `node kit/build.mjs` regenerates the committed example
 * (adapters/html/example/fragments/ from example/site.json); adapters/html/test/html.test.ts fails while it differs
 * from a fresh generation.
 *
 *   consent-mode.html            the site's Google Consent Mode defaults: everything denied, no url_passthrough
 *   head.html                    the config block (JSON, every "<" escaped), the inline head snippet, the inline styles
 *   <lang>/banner.html           kit/templates/banner.html rendered with the language's strings and the site's values
 *   <lang>/footer-link.html      the reopen link: the privacy URL, data-ck-open, the dialog's title as its text
 *   script.html                  kit.js: deferred, fingerprinted, with Subresource Integrity
 *   consent-kit/kit.<sha256>.js  dist/kit.js under that name, for the site's /consent-kit/
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { COMMITTED_DIST, LANGS, configBlock, escapeHtml, renderBanner, strings } from "../../kit/build.mjs";

/** Where script.html loads kit.js from: the site serves consent-kit/kit.<sha256>.js at this path. */
export const KIT_PATH = "/consent-kit/";

/** The site's Consent Mode defaults, the demo's (kit/README.md, Page structure): everything denied, no
 *  url_passthrough — the kit sets it, and only with marketing consent. */
export const CONSENT_MODE = `<script data-cfasync="false">
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  gtag("consent", "default", {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: "denied",
    functionality_storage: "denied",
    personalization_storage: "denied",
    security_storage: "granted",
    wait_for_update: 2000,
  });
  gtag("set", "ads_data_redaction", true);
</script>
`;

const CATEGORIES = ["analytics", "marketing"];
const NAME = /^[A-Za-z0-9_.-]+$/; // a cookie name, a site id
const COOKIE_PATTERN = /^[A-Za-z0-9_.-]+\*?$/; // a cookie name, or a prefix ending in "*"
const CONSENT_VALUE = /^[A-Za-z0-9_-]+$/; // a data-consent value
const DOMAIN = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const ENDPOINT = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?\/[^\s"'<>\\]*$/;
/** An https:// URL, a path that starts with one "/" (never "//" or "/\": another host, to a browser), a #fragment. */
const LINK = /^(https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?([/?#][^\s"'<>\\]*)?|\/([^/\\\s"'<>][^\s"'<>\\]*)?|#[^\s"'<>\\]+)$/;

const fail = (message) => {
  throw new Error(`consent-kit: ${message} (adapters/html/README.md, The site config)`);
};
const isObject = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
const show = (x) => (x === undefined ? "nothing" : JSON.stringify(x));
/** Fails on a key of `obj` that is not one of `keys`. */
function only(obj, keys, where) {
  for (const key of Object.keys(obj)) if (!keys.includes(key)) fail(`${where}${key} is not a key (${keys.join(", ")})`);
}
/** A list of strings that each match `pattern`. */
function list(value, pattern, where, what) {
  if (!Array.isArray(value)) fail(`${where} must be a list of ${what}, not ${show(value)}`);
  for (const item of value) if (typeof item !== "string" || !pattern.test(item)) fail(`${where}: ${show(item)} is not ${what}`);
  return value;
}

/** The site config, checked (adapters/html/README.md, The site config): every invalid value is an error — the
 *  kit would treat a bad revision or cookie as no config and do nothing at all, silently. */
function siteValues(site) {
  if (!isObject(site)) fail("the site config must be a JSON object");
  only(site, ["revision", "cookie", "domain", "categories", "cleanup", "legacy", "endpoint", "site", "languages"], "");
  const { revision, cookie, domain, categories = {}, cleanup, legacy, endpoint, site: id = "", languages } = site;
  if (!(typeof revision === "number" && Number.isInteger(revision) && revision >= 1 && revision <= 1e6)) {
    fail(`revision must be an integer from 1 to 1000000, not ${show(revision)}`);
  }
  if (typeof cookie !== "string" || !NAME.test(cookie)) fail(`cookie must be a cookie name (letters, digits, "_", ".", "-"), not ${show(cookie)}`);
  if (domain !== undefined && (typeof domain !== "string" || !DOMAIN.test(domain))) {
    fail(`domain must be a lower-case domain such as "example.com" (no scheme, port or leading dot), not ${show(domain)}`);
  }
  if (typeof endpoint !== "string" || !(endpoint === "" || ENDPOINT.test(endpoint))) {
    fail(`endpoint must be the records URL (https://…/v1/record), or "" for no records, not ${show(endpoint)}`);
  }
  if (typeof id !== "string" || !(id === "" || NAME.test(id))) fail(`site must be a site id (letters, digits, "_", ".", "-"), not ${show(id)}`);
  if (endpoint && !id) fail("site is missing: the endpoint needs the site id");

  if (!isObject(categories)) fail(`categories must be an object (analytics, marketing), not ${show(categories)}`);
  only(categories, CATEGORIES, "categories.");
  for (const [category, value] of Object.entries(categories)) {
    if (typeof value !== "string" || !CONSENT_VALUE.test(value)) fail(`categories.${category} must be a data-consent value (letters, digits, "_", "-"), not ${show(value)}`);
  }
  // every category: kit.js activates nothing for a category the config does not map
  const mapped = { analytics: "analytics", marketing: "marketing", ...categories };
  // one value for both would let a grant of either category activate the other's tags
  if (mapped.analytics === mapped.marketing) {
    fail(`categories: analytics and marketing must activate different data-consent values, not both ${show(mapped.analytics)}`);
  }
  if (cleanup !== undefined) {
    if (!isObject(cleanup)) fail(`cleanup must be an object (analytics, marketing), not ${show(cleanup)}`);
    only(cleanup, CATEGORIES, "cleanup.");
    for (const [category, rule] of Object.entries(cleanup)) {
      if (!isObject(rule)) fail(`cleanup.${category} must be an object (cookies, localStorage), not ${show(rule)}`);
      only(rule, ["cookies", "localStorage"], `cleanup.${category}.`);
      if (rule.cookies !== undefined) list(rule.cookies, COOKIE_PATTERN, `cleanup.${category}.cookies`, 'a cookie name or a prefix ending in "*"');
      for (const pattern of rule.cookies ?? []) {
        // kit.js's match: an exact name, or a prefix ending in "*" — the choice cookie would go with every denial
        if (pattern.endsWith("*") ? cookie.startsWith(pattern.slice(0, -1)) : pattern === cookie) {
          fail(`cleanup.${category}.cookies: ${show(pattern)} would delete the choice cookie ${show(cookie)}`);
        }
      }
      if (rule.localStorage !== undefined) list(rule.localStorage, /./s, `cleanup.${category}.localStorage`, "a non-empty key");
    }
  }
  if (legacy !== undefined && list(legacy, NAME, "legacy", 'a cookie name (letters, digits, "_", ".", "-")').includes(cookie)) {
    fail(`legacy: ${show(cookie)} is the choice cookie, which kit.js would delete on every page load`);
  }

  if (!isObject(languages) || !Object.keys(languages).length) fail(`languages must be an object with an entry per language (${LANGS.join(", ")})`);
  for (const [lang, values] of Object.entries(languages)) {
    if (!LANGS.includes(lang)) fail(`languages.${lang}: the kit has no strings for it (${LANGS.join(", ")})`);
    if (!isObject(values)) fail(`languages.${lang} must be an object (privacyUrl, imprintUrl, texts)`);
    only(values, ["privacyUrl", "imprintUrl", "texts"], `languages.${lang}.`);
    for (const key of ["privacyUrl", "imprintUrl"]) {
      if (typeof values[key] !== "string" || !LINK.test(values[key])) {
        fail(`languages.${lang}.${key} must be an https:// URL, a path that starts with one "/" or a #fragment, not ${show(values[key])}`);
      }
    }
    if (values.texts !== undefined) {
      const keys = Object.keys(strings(lang)).filter((key) => key !== "_note");
      if (!isObject(values.texts)) fail(`languages.${lang}.texts must be an object of the kit's string keys`);
      only(values.texts, keys, `languages.${lang}.texts.`);
      for (const [key, text] of Object.entries(values.texts)) {
        if (typeof text !== "string" || !text.trim()) fail(`languages.${lang}.texts.${key} must be a non-empty string, not ${show(text)}`);
      }
    }
  }

  const config = {
    revision,
    cookie,
    ...(domain === undefined ? {} : { domain }),
    categories: mapped,
    ...(cleanup === undefined ? {} : { cleanup }),
    ...(legacy === undefined ? {} : { legacy }),
  };
  return { config, endpoint, site: id, languages };
}

/** Every fragment and file of a site config, by its path below the output folder. */
export function generate(site) {
  const values = siteValues(site);
  const dist = (name) => readFileSync(path.join(COMMITTED_DIST, name), "utf8");
  const kit = dist("kit.js");
  const sha256 = createHash("sha256").update(kit).digest();
  const kitFile = `kit.${sha256.toString("hex")}.js`;
  const files = {
    "consent-mode.html": CONSENT_MODE,
    "head.html": [
      configBlock(values.config),
      `<script data-cfasync="false">${dist("head.js").trimEnd()}</script>`,
      `<style>${dist("kit.css").trimEnd()}</style>`,
    ].join("\n") + "\n",
    "script.html": `<script data-cfasync="false" src="${KIT_PATH}${kitFile}" integrity="sha256-${sha256.toString("base64")}" defer></script>\n`,
    [`consent-kit/${kitFile}`]: kit,
  };
  for (const [lang, { privacyUrl, imprintUrl, texts = {} }] of Object.entries(values.languages)) {
    files[`${lang}/banner.html`] = renderBanner(lang, { ...texts, privacyUrl, imprintUrl, endpoint: values.endpoint, site: values.site });
    const title = texts.dialogTitle ?? strings(lang).dialogTitle;
    files[`${lang}/footer-link.html`] = `<a href="${escapeHtml(privacyUrl)}" data-ck-open>${escapeHtml(title)}</a>\n`;
  }
  return files;
}

/** Writes `files` below `dir`, folders included; a file of another generation stays (a page still cached with an
 *  older script.html keeps finding its kit.<sha256>.js). */
export function write(files, dir) {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [config, out] = process.argv.slice(2);
  if (!config || !out) {
    console.error("usage: node adapters/html/generate.mjs <site.json> <out-dir>");
    process.exit(2);
  }
  const message = (error) => (error instanceof Error ? error.message : String(error)).replace(/^consent-kit: /, "");
  let files;
  try {
    files = generate(JSON.parse(readFileSync(config, "utf8")));
  } catch (error) {
    // reading, parsing and checking the site config: every failure names the file
    console.error(`consent-kit: ${config}: ${message(error)}`);
    process.exit(1);
  }
  try {
    write(files, out);
  } catch (error) {
    console.error(`consent-kit: ${message(error)}`);
    process.exit(1);
  }
  for (const rel of Object.keys(files)) console.log(path.join(out, rel));
}
