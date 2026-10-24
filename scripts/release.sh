#!/bin/sh
# Prepares a release: checks the version, runs the tests, sets the version, builds, scans for
# secrets, and writes release/SG Haze.js and version.json, which the updater fetches from GitHub.
# Usage: sh scripts/release.sh <version> "<release notes>"
set -eu

cd "$(dirname "$0")/.."

if [ $# -ne 2 ]; then
  echo 'usage: sh scripts/release.sh <version> "<release notes>"' >&2
  exit 2
fi
VERSION=$1
NOTES=$2

# Must be x.y.z and newer than the last release in version.json, if there is one.
node -e '
const fs = require("node:fs");
const { compareVersions, isVersion, parseManifest } = require("./src/core.js");
const next = process.argv[1];
if (!isVersion(next)) {
  console.error(`not an x.y.z version: ${next}`);
  process.exit(1);
}
const last = fs.existsSync("version.json") ? parseManifest(fs.readFileSync("version.json", "utf8"))?.version : null;
if (last && compareVersions(next, last) !== 1) {
  console.error(`${next} is not newer than the last release, ${last}`);
  process.exit(1);
}
' "$VERSION"

npm test

node -e '
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.version = process.argv[1];
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
' "$VERSION"

node scripts/build.js
node scripts/check-secrets.js "dist/SG Haze.js"
mkdir -p release
cp "dist/SG Haze.js" "release/SG Haze.js"

node -e '
const fs = require("node:fs");
const [version, notes] = process.argv.slice(1);
fs.writeFileSync("version.json", JSON.stringify({ version, notes }, null, 2) + "\n");
' "$VERSION" "$NOTES"

echo
echo "Release $VERSION is ready in release/ and version.json. Next:"
echo "  1. Add a $VERSION entry to CHANGELOG.md"
echo "  2. git add -A && git commit -m \"Release $VERSION\" && git tag v$VERSION"
echo "  3. git push && git push --tags"
echo "Friends with update checks on will see it within a day of the push."
