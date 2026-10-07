#!/bin/bash
# The helper's full suite, the extension's tests, and the web-form fixtures' typecheck and tests, at the pinned commit
# (I1's window step, from ~/.caret-run/evidence/screen/i1/chain.sh). Every suite runs; the recipe exits 11 if any
# failed. Profile caret-helper-suite.
#   helper-window.sh TAG
set -u
. "$CARET_HEAVY_RECIPES/lib.sh"
TAG=${1:?usage: helper-window.sh TAG}
install_deps helper extension fixtures/web-form || finish
run_suite "helper-$TAG" vitest helper pnpm test
run_suite "extension-$TAG" vitest extension pnpm test
run_suite "fixtures-tsc-$TAG" tsc fixtures/web-form npx tsc --noEmit -p tsconfig.json
run_suite "fixtures-test-$TAG" node-test fixtures/web-form node --test tests/owners.test.ts tests/expect.test.ts
finish
