#!/bin/bash
# Build dsh-upgrade-guard host side: src/ -> lib/.
# Works without a DSH source checkout: uses the local TypeScript devDependency.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TSC="node_modules/.bin/tsc"
if [ ! -x "$TSC" ]; then
  echo "build: local tsc not found — run 'npm install' in $ROOT first" >&2
  exit 1
fi

echo "=== Compiling host (tsc $("$TSC" --version)) ==="
"$TSC" -p tsconfig.json

echo "=== Copying supervisor asset ==="
mkdir -p lib
cp scripts/supervisor.mjs lib/supervisor.mjs
cp scripts/probe-runner.mjs lib/probe-runner.mjs

echo "=== Host build complete ==="
ls -la lib/ 2>/dev/null | head
