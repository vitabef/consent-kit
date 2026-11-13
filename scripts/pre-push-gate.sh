#!/usr/bin/env sh
# =============================================================================
# pre-push-gate.sh — the LOCAL quality gate of the consent-kit repo.
#   1. typecheck  — tsc --noEmit (the Worker source)
#   2. typecheck  — tsc -p tsconfig.test.json (the tests and vitest.config.ts)
#   3. tests      — vitest run (kit in happy-dom + build checks, Worker in node)
#   4. kit build  — node kit/build.mjs: minify, write kit/dist/, exit 1 over a brotli budget
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
step "Tests (vitest run)"                  ./node_modules/.bin/vitest run
step "Kit build + brotli budgets"          node kit/build.mjs

printf '\n\033[32m✓ pre-push gate GREEN — push-ready\033[0m\n'
