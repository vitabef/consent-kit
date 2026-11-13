/**
 * Hugo extended for the adapter tests, through mise — `mise x hugo-extended@<version> -- hugo …` — in two versions:
 * HUGO_MIN, the module's minimum (hugo.toml `hugoVersion.min`), and HUGO_NEWEST, the newest one tested (raised on
 * purpose: the whole suite passes with it, and adapters/hugo/README.md names it). Never installed on the fly
 * (MISE_EXEC_AUTO_INSTALL=false) — and since mise then falls back to any other `hugo` on the PATH, the probe checks
 * the version line as well.
 *
 * `node adapters/hugo/test/hugo.mjs` prints the verdict per version for the gate: exit 0 = the example-site build
 * tests RUN with both, exit 3 = they are SKIPPED for at least one (no such Hugo here), any other code = the probe
 * itself failed.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const HUGO_MIN = "0.141.0";
export const HUGO_NEWEST = "0.169.0";
/** Every Hugo version the build tests run with. */
export const HUGO_VERSIONS = [HUGO_MIN, HUGO_NEWEST];

/** The mise tool of a Hugo version. */
export const hugoTool = (version) => `hugo-extended@${version}`;

/** Runs Hugo `version` extended with these arguments; `env` is added to the environment. */
export function runHugo(version, args, env = {}) {
  return spawnSync("mise", ["x", hugoTool(version), "--", "hugo", ...args], {
    encoding: "utf8",
    env: { ...process.env, MISE_EXEC_AUTO_INSTALL: "false", ...env },
    timeout: 120000,
  });
}

/** `{ ok: true, version }` when Hugo `version` extended runs here, else `{ ok: false, reason }`. */
export function probeHugo(version) {
  const r = runHugo(version, ["version"]);
  if (r.error) return { ok: false, reason: `mise could not be started (${r.error.message})` };
  const line = (r.stdout || "").trim().split("\n")[0] || "";
  const wanted = new RegExp(`^hugo v${version.replace(/\./g, "\\.")}-[0-9a-f]+\\+extended `);
  if (r.status === 0 && wanted.test(line)) return { ok: true, version: line };
  const got = line || (r.stderr || "").trim().split("\n")[0] || `exit ${r.status}`;
  return { ok: false, reason: `\`mise x ${hugoTool(version)} -- hugo version\` gave: ${got}` };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  let skipped = 0;
  for (const version of HUGO_VERSIONS) {
    const probe = probeHugo(version);
    if (probe.ok) {
      console.log(`Hugo ${version} extended found: the example-site build tests RUN with it (${probe.version})`);
    } else {
      skipped += 1;
      console.log(`WARNING: Hugo ${version} extended NOT available: the example-site build tests with it are SKIPPED.`);
      console.log(`  ${probe.reason}`);
      console.log(`  Install it with: mise install ${hugoTool(version)}`);
    }
  }
  if (skipped) process.exit(3);
}
