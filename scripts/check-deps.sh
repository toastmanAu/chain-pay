#!/usr/bin/env bash
# Audit ChainPay source-build dependencies without installing anything.
# Usage: ./scripts/check-deps.sh [--with-dev]
# Overrides: CHAINPAY_NODE, CHAINPAY_NPM, CHAINPAY_PYTHON
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
node_bin=${CHAINPAY_NODE:-node}
npm_bin=${CHAINPAY_NPM:-npm}
with_dev=false
if [[ ${1:-} == --with-dev ]]; then
  with_dev=true
elif [[ $# -gt 0 ]]; then
  printf 'Usage: %s [--with-dev]\n' "$0" >&2
  exit 2
fi

if [[ -t 1 ]]; then
  green=$'\033[32m'; yellow=$'\033[33m'; red=$'\033[31m'; reset=$'\033[0m'
else
  green=''; yellow=''; red=''; reset=''
fi

missing=0
printf 'ChainPay source-build environment audit\n'
if ! command -v "$node_bin" >/dev/null 2>&1; then
  printf '  %s✗%s Node.js — missing (%s)\n' "$red" "$reset" "$node_bin"
  missing=$((missing + 1))
else
  printf '  %s✓%s Node.js %s\n' "$green" "$reset" "$("$node_bin" --version)"
fi
if ! command -v "$npm_bin" >/dev/null 2>&1; then
  printf '  %s✗%s npm — missing (%s)\n' "$red" "$reset" "$npm_bin"
  missing=$((missing + 1))
else
  printf '  %s✓%s npm %s\n' "$green" "$reset" "$("$npm_bin" --version)"
fi

if [[ $missing -gt 0 ]]; then
  printf '%s%d missing required tools. Install them before building.%s\n' "$red" "$missing" "$reset"
  exit 1
fi

printf '\nOptional Frappe backend package (normally provided by its container):\n'
python_bin=${CHAINPAY_PYTHON:-}
if [[ -z $python_bin ]]; then
  if command -v python3 >/dev/null 2>&1; then python_bin=python3
  elif command -v python >/dev/null 2>&1; then python_bin=python
  fi
fi
if [[ -n $python_bin ]] && command -v "$python_bin" >/dev/null 2>&1; then
  python_result=$("$python_bin" - <<'PYTHON'
import importlib.metadata
try:
    version = importlib.metadata.version("requests")
except importlib.metadata.PackageNotFoundError:
    print("requests missing (optional)")
else:
    parts = tuple(int(part) for part in version.split(".")[:2] if part.isdigit())
    print(f"requests {version}" + (" (below 2.31)" if parts < (2, 31) else ""))
PYTHON
  )
  printf '  - %s\n' "$python_result"
else
  printf '  - Python unavailable (optional for desktop builds)\n'
fi

"$node_bin" - "$repo_root" "$with_dev" "$("$npm_bin" --version)" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const withDev = process.argv[3] === 'true';
const color = process.stdout.isTTY
  ? { ok: '\x1b[32m', warn: '\x1b[33m', bad: '\x1b[31m', reset: '\x1b[0m' }
  : { ok: '', warn: '', bad: '', reset: '' };
const rootManifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const minimum = {
  node: rootManifest.engines.node.match(/\d+(?:\.\d+){0,2}/)[0],
  npm: rootManifest.engines.npm.match(/\d+(?:\.\d+){0,2}/)[0],
};
const tuple = value => (String(value).match(/\d+(?:\.\d+){0,2}/)?.[0] ?? '0')
  .split('.').map(Number).concat([0, 0]).slice(0, 3);
const older = (have, need) => {
  const a = tuple(have); const b = tuple(need);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i]; }
  return false;
};
let missing = 0; let outdated = 0; let checked = 0;
for (const [tool, have] of [['node', process.versions.node], ['npm', process.argv[4]]]) {
  if (older(have, minimum[tool])) {
    console.log(`  ${color.bad}✗${color.reset} ${tool} ${have} — need >= ${minimum[tool]}`);
    missing++;
  }
}
const packageSets = [
  ['root', '.'],
  ['desktop', 'apps/desktop'],
  ['shared', 'packages/shared'],
  ['cemp-pq', 'packages/cemp-pq'],
  ['mobile', 'apps/mobile'],
];
const seen = new Set();
for (const [label, relative] of packageSets) {
  const workspace = path.join(root, relative);
  const manifest = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'));
  const deps = { ...manifest.dependencies, ...(withDev ? manifest.devDependencies : {}) };
  console.log(`\n${label} ${withDev ? 'build + runtime' : 'runtime'} packages:`);
  for (const [name, range] of Object.entries(deps)) {
    if (seen.has(name)) continue;
    seen.add(name); checked++;
    const candidates = [
      path.join(workspace, 'node_modules', name, 'package.json'),
      path.join(root, 'node_modules', name, 'package.json'),
    ];
    const installedPath = candidates.find(candidate => fs.existsSync(candidate));
    if (!installedPath) {
      console.log(`  ${color.bad}✗${color.reset} ${name} — missing`);
      missing++; continue;
    }
    const installed = JSON.parse(fs.readFileSync(installedPath, 'utf8')).version;
    const required = String(range).match(/\d+(?:\.\d+){0,2}/)?.[0];
    if (required && older(installed, required)) {
      console.log(`  ${color.warn}!${color.reset} ${name} ${installed} — manifest minimum ${required}`);
      outdated++;
    } else {
      console.log(`  ${color.ok}✓${color.reset} ${name} ${installed}`);
    }
  }
}
if (withDev) {
  console.log('\nOptional keyvault WASM rebuild:');
  for (const tool of ['cargo', 'rustc', 'wasm-pack']) {
    const available = require('node:child_process').spawnSync('sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' }).status === 0;
    console.log(`  ${available ? color.ok + '✓' : color.warn + '-'}${color.reset} ${tool}${available ? '' : ' (optional; prebuilt WASM is included)'}`);
  }
}
console.log(`\n${checked} direct packages checked; ${missing} missing, ${outdated} below manifest minimum.`);
process.exitCode = missing > 0 ? 1 : 0;
NODE
