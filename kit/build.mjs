#!/usr/bin/env node
/**
 * consent-kit build — `node kit/build.mjs` (`npm run build`).
 *
 * Minifies the three shipped files with esbuild (the repo's devDependency) and writes kit/dist/:
 *   head.js     the inline head snippet (the adapter inlines it)
 *   kit.js      the deferred logic file (the adapter vendors and fingerprints it)
 *   kit.css     the styles (the adapter inlines them)
 *   sizes.json  raw / gzip / brotli bytes per file and the brotli budget (head ≤ 1 KB, CSS ≤ 3 KB, JS ≤ 6 KB)
 *   demo/       the fake host page rendered for DE (demo/index.html) and EN (demo/en/index.html)
 * Exit 1 when a file is over its budget. The functions are exported so the tests run the SAME minified
 * bytes the sites ship, and render the same reference markup.
 */
import { transform } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, "dist");

/** Brotli budgets in bytes: ~1.5 × the first build (608 / 1443 / 1672 B), so a real regression fails the
 *  test; the hard ceilings stay 1 KB / 3 KB / 6 KB (the kit sits on every page of a site). */
export const BUDGETS = { "head.js": 900, "kit.css": 2200, "kit.js": 2500 };

const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

/** The three shipped files, minified. */
export async function buildAssets() {
  const js = async (rel) =>
    (await transform(read(rel), { loader: "js", minify: true, target: "es2017", legalComments: "none" })).code.trim();
  const css = (await transform(read("src/kit.css"), { loader: "css", minify: true, legalComments: "none" })).code.trim();
  return { "head.js": await js("src/head.js"), "kit.js": await js("src/kit.js"), "kit.css": css };
}

/** raw / gzip (level 9) / brotli (quality 11) bytes of a text. */
export function measure(text) {
  const buf = Buffer.from(text, "utf8");
  return {
    raw: buf.length,
    gzip: gzipSync(buf, { level: 9 }).length,
    brotli: brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
}

/** The reference strings of a language (src/i18n/<lang>.json). */
export function strings(lang) {
  return JSON.parse(read(`src/i18n/${lang}.json`));
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Drops the developer comments; keeps the ck: markers. */
const stripComments = (html) => html.replace(/<!--(?!ck:)[\s\S]*?-->\n?/g, "");

/** Fills every {{key}} from `values`; a placeholder without a value is an error, never an empty string. */
function fill(html, values, where) {
  return html.replace(/\{\{\s*([A-Za-z]\w*)\s*\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`${where}: no value for {{${key}}}`);
    return escapeHtml(String(values[key]));
  });
}

/** templates/banner.html for a language — what an adapter renders (vars: privacyUrl, imprintUrl, endpoint, site). */
export function renderBanner(lang, vars) {
  return fill(stripComments(read("templates/banner.html")), { ...strings(lang), ...vars }, "templates/banner.html");
}

/** The demo's kit config. A site's production values — the config's `revision` and cookie `domain`, layer 1's
 *  endpoint and site id — are set by that site's adapter: the config keys are documented in kit/README.md
 *  § The config block, the endpoint and site id in § The markup. */
function demoConfig() {
  return {
    revision: 1,
    cookie: "ck_consent",
    categories: { analytics: "analytics", marketing: "marketing" },
    cleanup: {
      analytics: { cookies: ["_ga", "_ga_*"] },
      marketing: { cookies: ["_gcl_*"], localStorage: ["_gcl_ls"] },
    },
    legacy: ["previous-tool-consent"],
  };
}

/** The demo's markup values: anchors in the page's language, an empty endpoint — the demo sends no records. */
const DEMO_VARS = {
  de: { privacyUrl: "#datenschutz", imprintUrl: "#impressum", endpoint: "", site: "example-site" },
  en: { privacyUrl: "#privacy", imprintUrl: "#imprint", endpoint: "", site: "example-site" },
};

/** The config block an adapter emits: JSON with `<` escaped, so no string can close the element. */
export function configBlock(cfg) {
  return `<script type="application/json" id="ck-config">${JSON.stringify(cfg).replace(/</g, "\\u003c")}</script>`;
}

const DEMO = {
  de: {
    demoTitle: "Consent-Kit: Demo-Host",
    demoLogo: "Demo-Host",
    demoHeading: "Beispiel-Website",
    demoLede: "Eine Fake-Hostseite für das Consent-Kit",
    demoCta: "Mehr erfahren",
    demoSection: "Über diese Seite",
    demoText:
      "Platzhaltertext der Demo-Hostseite. Er füllt die Seite, damit sie scrollt und die erste Ebene über echtem Inhalt liegt, so wie auf einer echten Website.",
    demoCookieLink: "Cookie-Einstellungen",
  },
  en: {
    demoTitle: "Consent kit: demo host",
    demoLogo: "Demo host",
    demoHeading: "Example website",
    demoLede: "A fake host page for the consent kit",
    demoCta: "Learn more",
    demoSection: "About this page",
    demoText:
      "Placeholder text of the demo host page. It fills the page so that it scrolls and the first layer sits over real content, as it does on a real website.",
    demoCookieLink: "Cookie settings",
  },
};

/** The demo page of a language, with the kit emitted the way an adapter emits it. */
export function renderDemo(lang, assets) {
  const page = fill(stripComments(read("demo/index.html")), { lang, ...strings(lang), ...DEMO[lang], ...DEMO_VARS[lang] }, "demo/index.html");
  const head = [
    configBlock(demoConfig()),
    `<script data-cfasync="false">${assets["head.js"]}</script>`,
    `<style>${assets["kit.css"]}</style>`,
  ].join("\n");
  return page
    .replace("<!--ck:head-->", () => head)
    .replace("<!--ck:banner-->", () => renderBanner(lang, DEMO_VARS[lang]).trim())
    .replace("<!--ck:kit-->", () => '<script data-cfasync="false" src="/kit.js" defer></script>');
}

async function main() {
  const assets = await buildAssets();
  mkdirSync(path.join(DIST, "demo", "en"), { recursive: true });
  const sizes = {};
  let over = false;
  for (const [name, text] of Object.entries(assets)) {
    writeFileSync(path.join(DIST, name), text + "\n");
    const m = measure(text);
    sizes[name] = { ...m, budgetBrotli: BUDGETS[name] };
    if (m.brotli > BUDGETS[name]) over = true;
    console.log(`${name.padEnd(8)} raw ${String(m.raw).padStart(6)}  gzip ${String(m.gzip).padStart(5)}  brotli ${String(m.brotli).padStart(5)} / ${BUDGETS[name]}`);
  }
  writeFileSync(path.join(DIST, "sizes.json"), JSON.stringify(sizes, null, 2) + "\n");
  writeFileSync(path.join(DIST, "demo", "index.html"), renderDemo("de", assets));
  writeFileSync(path.join(DIST, "demo", "en", "index.html"), renderDemo("en", assets));
  writeFileSync(path.join(DIST, "demo", "fake-analytics.js"), read("demo/fake-analytics.js"));
  if (over) {
    console.error("consent-kit: a file is over its brotli budget (see above)");
    process.exit(1);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
