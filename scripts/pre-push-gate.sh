#!/usr/bin/env sh
# =============================================================================
# pre-push-gate.sh — the LOCAL quality gate of the consent-kit repo.
#   1. typecheck  — tsc --noEmit (the Worker source)
#   2. typecheck  — tsc -p tsconfig.test.json (the tests and vitest.config.ts)
#   3. hugo       — are Hugo 0.141.0 extended (the module's minimum) and 0.169.0 extended (the newest tested) here
#                   (mise; adapters/hugo/test/hugo.mjs)? The Hugo adapter's build tests with a missing one are
#                   SKIPPED: said here and in the last line, never silently
#   4. tests      — vitest run (kit in happy-dom + build checks with the drift guards of dist/ and the Hugo
#                   adapter's generated files, the Hugo example-site build, Worker in node)
#   5. kit build  — node kit/build.mjs: minify, write kit/dist/, dist/ and the Hugo adapter's generated files,
#                   exit 1 over a brotli budget
# Exit code: 0 = all green (push-ready), non-zero = a step failed (DO NOT push).
# Usage: sh scripts/pre-push-gate.sh   (or: npm run gate)
# =============================================================================
set -eu

# Sandboxed shells sometimes point TMPDIR at a broken dir → vitest/node ENOSPC.
export TMPDIR="${TMPDIR:-/tmp}"

# Run from the repo root regardless of where we were invoked from.
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

step() {  # step <label> <cmd...>
  label="$1"; shift
  printf '\n\033[1m▶ %s\033[0m\n' "$label"
  if "$@"; then
    printf '\033[32m  ✓ %s\033[0m\n' "$label"
  else
    printf '\033[31m  ✗ %s FAILED — DO NOT PUSH\033[0m\n' "$label"
    exit 1
  fi
}

step "Typecheck (tsc --noEmit)"            ./node_modules/.bin/tsc --noEmit
step "Typecheck tests (tsconfig.test.json)" ./node_modules/.bin/tsc -p tsconfig.test.json --noEmit

# The probe exits 0 (the Hugo build tests run with both versions), 3 (they are skipped for one: no such Hugo
# extended here) or else (broken).
printf '\n\033[1m▶ %s\033[0m\n' "Hugo 0.141.0 and 0.169.0 for the adapter's build tests"
hugo_status=0
node adapters/hugo/test/hugo.mjs || hugo_status=$?
case "$hugo_status" in
  0) hugo_skipped="" ;;
  3) hugo_skipped=1 ;;
  *) printf '\033[31m  ✗ the Hugo probe FAILED — DO NOT PUSH\033[0m\n'; exit 1 ;;
esac

step "Tests (vitest run)"                  ./node_modules/.bin/vitest run
step "Kit build + brotli budgets"          node kit/build.mjs

if [ -n "$hugo_skipped" ]; then
  printf '\n\033[33m✓ pre-push gate GREEN — but WITHOUT Hugo build tests: SKIPPED for a Hugo version missing here (see the Hugo step)\033[0m\n'
else
  printf '\n\033[32m✓ pre-push gate GREEN — push-ready (Hugo build tests included: 0.141.0 and 0.169.0)\033[0m\n'
fi
