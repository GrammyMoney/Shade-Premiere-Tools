#!/bin/bash
# Build the installable panel: dist/<plugin id>_premierepro.ccx
#
# A .ccx is a plain zip of the plugin with manifest.json at its root -- the
# same thing the UXP Developer Tool's "Package" button makes (compared
# against a UDT-built .ccx from premiere-events: three files at the root, no
# signature, no META-INF). Double-clicking one hands it to Creative Cloud,
# which installs it for Premiere.
#
# Checks first what only the INSTALLED path enforces, because UDT loads a
# broken plugin happily and the installed one then silently isn't there:
#   - manifest "host" must be an object, not an array (cost premiere-events a
#     release)
#   - every file a script requires must be in the package
#
# Must stay bash 3.2-safe: it runs on stock macOS.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/plugin"
DIST="$ROOT/dist"

command -v node >/dev/null 2>&1 || PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v node >/dev/null 2>&1 || { echo "node not found (needed to read the manifest)"; exit 1; }

# What ships: the manifest, the panel, and the scripts at the plugin root.
# Not tests, not package.json.
FILES="manifest.json index.html"
for f in "$SRC"/*.js; do FILES="$FILES $(basename "$f")"; done
if [ -d "$SRC/icons" ]; then FILES="$FILES icons"; fi

# Validate, in one node call so the rules live in one place.
node - "$SRC" $FILES <<'JS'
const fs = require("fs"), path = require("path");
const [src, ...files] = process.argv.slice(2);
const fail = (m) => { console.error("package: " + m); process.exit(1); };
const m = JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8"));

if (!m.id || !m.version) fail("manifest needs id and version");
if (m.manifestVersion !== 5) fail(`manifestVersion is ${m.manifestVersion}; this plugin is v5 on purpose (see CLAUDE.md)`);
if (!m.host || Array.isArray(m.host) || typeof m.host !== "object")
  fail('manifest "host" must be an object, not an array -- installed Premiere rejects the array form');
if (m.host.app !== "premierepro") fail(`host.app is ${m.host.app}`);
if (!files.includes(m.main)) fail(`main "${m.main}" is not in the package`);

// Every relative require must resolve to a shipped file.
const shipped = new Set(files);
for (const f of files.filter((f) => f.endsWith(".js"))) {
  const code = fs.readFileSync(path.join(src, f), "utf8");
  for (const r of code.matchAll(/require\(\s*["']\.\/([^"']+)["']\s*\)/g)) {
    if (!shipped.has(r[1])) fail(`${f} requires ./${r[1]}, which is not in the package`);
  }
}
// And the page's own script.
const html = fs.readFileSync(path.join(src, m.main), "utf8");
for (const s of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
  if (!shipped.has(s[1])) fail(`${m.main} loads ${s[1]}, which is not in the package`);
}
console.log(`${m.name} ${m.version} (${m.id}): manifest ok, ${files.length} files`);
JS

ID=$(node -p "require('$SRC/manifest.json').id")
OUT="$DIST/${ID}_premierepro.ccx"
mkdir -p "$DIST"
rm -f "$OUT"
# -X: no extra file attributes, like UDT's. -D: no directory entries.
(cd "$SRC" && zip -q -X -D -r "$OUT" $FILES)

echo "built $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
unzip -Z1 "$OUT" | sed 's/^/  /'
