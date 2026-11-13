/**
 * Hugo 0.141.0 extended (the module's minimum) for the adapter tests, through mise:
 * `mise x hugo-extended@0.141.0 -- hugo …`. Never installed on the fly (MISE_EXEC_AUTO_INSTALL=false) — and since
 * mise then falls back to any other `hugo` on the PATH, the probe checks the version line as well.
 *
 * `node adapters/hugo/test/hugo.mjs` prints the verdict for the gate: exit 0 = the example-site build tests RUN,
 * exit 3 = they are SKIPPED (no such Hugo here), any other code = the probe itself failed.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const HUGO_VERSION = "0.141.0";
export const HUGO_TOOL = `hugo-extended@${HUGO_VERSION}`;

/** Runs Hugo 0.141.0 extended with these arguments; `env` is added to the environment. */
export function runHugo(args, env = {}) {
  return spawnSync("mise", ["x", HUGO_TOOL, "--", "hugo", ...args], {
    encoding: "utf8",
    env: { ...process.env, MISE_EXEC_AUTO_INSTALL: "false", ...env },
    timeout: 120000,
  });
}

/** `{ ok: true, version }` when Hugo 0.141.0 extended runs here, else `{ ok: false, reason }`. */
export function probeHugo() {
  const r = runHugo(["version"]);
  if (r.error) return { ok: false, reason: `mise could not be started (${r.error.message})` };
  const line = (r.stdout || "").trim().split("\n")[0] || "";
  const wanted = new RegExp(`^hugo v${HUGO_VERSION.replace(/\./g, "\\.")}-[0-9a-f]+\\+extended `);
  if (r.status === 0 && wanted.test(line)) return { ok: true, version: line };
  const got = line || (r.stderr || "").trim().split("\n")[0] || `exit ${r.status}`;
  return { ok: false, reason: `\`mise x ${HUGO_TOOL} -- hugo version\` gave: ${got}` };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const probe = probeHugo();
  if (probe.ok) {
    console.log(`Hugo ${HUGO_VERSION} extended found: the example-site build tests RUN (${probe.version})`);
  } else {
    console.log(`WARNING: Hugo ${HUGO_VERSION} extended NOT available: the example-site build tests are SKIPPED.`);
    console.log(`  ${probe.reason}`);
    console.log(`  Install it with: mise install ${HUGO_TOOL}`);
    process.exit(3);
  }
}
