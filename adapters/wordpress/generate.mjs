/**
 * The WordPress plugin's GENERATED files — written by `node kit/build.mjs` (`npm run build`) into
 * adapters/wordpress/consent-kit/, so the plugin cannot drift from the kit; adapters/wordpress/test/wordpress.test.ts
 * fails when a committed copy differs from a fresh generation.
 *
 *   fragments/  the HTML adapter's fragments (fragments() in adapters/html/generate.mjs) rendered with placeholders
 *               as the site's values — {{privacyUrl}}, {{imprintUrl}}, {{endpoint}}, {{site}}, {{kitPath}} and the
 *               config block's JSON string "{{config}}" — which the plugin fills on every page (includes/Site.php);
 *               kit.js under its SHA-256 name, served from the plugin folder
 *   helper/     adapters/php/src/ byte for byte: the PHP helper (Config, ConsentCookie, Verdict)
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { LANGS, REPO } from "../../kit/build.mjs";
import { fragments } from "../html/generate.mjs";

/** The site values the fragments are rendered with: the placeholders the plugin fills. */
export const PLACEHOLDERS = {
  config: "{{config}}",
  endpoint: "{{endpoint}}",
  site: "{{site}}",
  languages: Object.fromEntries(LANGS.map((lang) => [lang, { privacyUrl: "{{privacyUrl}}", imprintUrl: "{{imprintUrl}}" }])),
};

/** Every generated file, by its path below adapters/wordpress/consent-kit/. */
export function generate() {
  /** @type {Record<string, string>} */
  const files = {};
  for (const [rel, text] of Object.entries(fragments(PLACEHOLDERS, "{{kitPath}}"))) files[`fragments/${rel}`] = text;
  const helper = path.join(REPO, "adapters/php/src");
  for (const name of readdirSync(helper).sort()) files[`helper/${name}`] = readFileSync(path.join(helper, name), "utf8");
  return files;
}
