/**
 * The WordPress plugin's GENERATED files — written by `node kit/build.mjs` (`npm run build`) into
 * adapters/wordpress/consent-kit/, so the plugin cannot drift from the kit; adapters/wordpress/test/wordpress.test.ts
 * fails when a committed copy differs from a fresh generation.
 *
 *   fragments/  the HTML adapter's fragments (fragments() in adapters/html/generate.mjs) rendered with placeholders
 *               as the site's values — {{endpoint}}, {{site}}, {{kitPath}} and the config block's JSON string
 *               "{{config}}" —; banner.html, the reference markup with every placeholder kept, the strings' too
 *               ({{key}}, {{text|blocks}}), and footer-link.html, the reopen link with {{privacyUrl}} and
 *               {{dialogTitle}}: the plugin fills them on every page (includes/Site.php); kit.js under its SHA-256
 *               name, served from the plugin folder
 *   i18n/       kit/src/i18n/ byte for byte: the kit's sample strings, for every text a site leaves out
 *   helper/     adapters/php/src/ byte for byte: the PHP helper (Config, ConsentCookie, Verdict)
 * And the texts parity fixture of the plugin's tests (textsFixture()).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { LANGS, REPO, bannerTemplate, replacePlaceholders } from "../../kit/build.mjs";
import { footerLink, fragments, generate as html } from "../html/generate.mjs";

/** The site values the fragments are rendered with: the placeholders the plugin fills. No language: the first layer
 *  and the reopen link are written once, below, with the strings as placeholders as well. */
export const PLACEHOLDERS = { config: "{{config}}", endpoint: "{{endpoint}}", site: "{{site}}", languages: {} };

/** Every generated file, by its path below adapters/wordpress/consent-kit/. */
export function generate() {
  /** @type {Record<string, string>} */
  const files = {};
  for (const [rel, text] of Object.entries(fragments(PLACEHOLDERS, "{{kitPath}}"))) files[`fragments/${rel}`] = text;
  // each placeholder in its one form: includes/Site.php fills them as renderBanner() in kit/build.mjs does
  files["fragments/banner.html"] = replacePlaceholders(bannerTemplate(), (key, filter) => (filter ? `{{${key}|${filter}}}` : `{{${key}}}`));
  files["fragments/footer-link.html"] = footerLink("{{privacyUrl}}", "{{dialogTitle}}");
  for (const lang of LANGS) files[`i18n/${lang}.json`] = readFileSync(path.join(REPO, `kit/src/i18n/${lang}.json`), "utf8");
  const helper = path.join(REPO, "adapters/php/src");
  for (const name of readdirSync(helper).sort()) files[`helper/${name}`] = readFileSync(path.join(helper, name), "utf8");
  return files;
}

/** The texts parity fixture, by its path below adapters/wordpress/: the HTML adapter's first layer, dialog and reopen
 *  link for its example's English with the site's own texts of test/texts.json — the bytes the plugin renders for
 *  test/settings.json with those texts (test/SiteTest.php, test/run.sh). */
export function textsFixture() {
  const read = (rel) => JSON.parse(readFileSync(path.join(REPO, rel), "utf8"));
  const site = read("adapters/html/example/site.json");
  site.languages.en.texts = read("adapters/wordpress/test/texts.json");
  const files = html(site);
  return { "test/texts/banner.html": files["en/banner.html"], "test/texts/footer-link.html": files["en/footer-link.html"] };
}
