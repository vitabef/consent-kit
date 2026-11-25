#!/usr/bin/env sh
# =============================================================================
# pre-push-gate.sh — the LOCAL quality gate of the consent-kit repo.
#   1. typecheck  — tsc --noEmit (the Worker source)
#   2. typecheck  — tsc -p tsconfig.test.json (the tests and vitest.config.ts)
#   3. hugo       — are Hugo 0.141.0 extended (the module's minimum) and 0.169.0 extended (the newest tested) here
#                   (mise; adapters/hugo/test/hugo.mjs)? The Hugo adapter's build tests with a missing one are
#                   SKIPPED: said here and in the last line, never silently
#   4. tests      — vitest run (kit in happy-dom + build checks with the drift guards of dist/, the Hugo
#                   adapter's generated files and the HTML adapter's example, the Hugo example-site build, the
#                   stored-choice vectors, Worker in node)
#   5. kit build  — node kit/build.mjs: minify, write kit/dist/, dist/, the Hugo adapter's generated files and the
#                   HTML adapter's example, exit 1 over a brotli budget
#   6. php        — the PHP helper's PHPUnit suite (adapters/php), where php and its dev install (composer install
#                   in adapters/php) are here — SKIPPED otherwise: said there and in the last line, never silently
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

# The gate installs nothing: the PHP suite runs only with php and the helper's dev install already here.
php_skipped=""
if command -v php >/dev/null 2>&1 && [ -f adapters/php/vendor/bin/phpunit ]; then
  step "PHP helper tests (phpunit)"        php adapters/php/vendor/bin/phpunit --configuration adapters/php/phpunit.xml.dist
else
  php_skipped=1
  printf '\n\033[1m▶ %s\033[0m\n' "PHP helper tests (phpunit)"
  printf '\033[33m  WARNING: php or the dev install of the helper is missing here: the PHP helper tests are SKIPPED.\033[0m\n'
  printf '  Install it with: composer install --working-dir=adapters/php\n'
fi

skipped=""
if [ -n "$hugo_skipped" ]; then skipped="Hugo build tests (a Hugo version missing here)"; fi
if [ -n "$php_skipped" ]; then skipped="${skipped:+$skipped and }PHP helper tests (no php or dev install here)"; fi
if [ -n "$skipped" ]; then
  printf '\n\033[33m✓ pre-push gate GREEN — but WITHOUT %s: SKIPPED (see their steps)\033[0m\n' "$skipped"
else
  printf '\n\033[32m✓ pre-push gate GREEN — push-ready (Hugo build tests included: 0.141.0 and 0.169.0; PHP helper tests included)\033[0m\n'
fi
