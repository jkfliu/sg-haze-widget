#!/bin/sh
# Builds the bundle and copies it into the iCloud Scriptable folder, where it syncs to the phone.
# Usage: sh scripts/deploy.sh
set -eu

cd "$(dirname "$0")/.."
DEST="$HOME/Library/Mobile Documents/iCloud~dk~simonbs~Scriptable/Documents"

if [ ! -d "$DEST" ]; then
  echo "Scriptable iCloud folder not found: $DEST" >&2
  echo "Open Scriptable on a device signed in to the same iCloud account first." >&2
  exit 1
fi

node scripts/build.js
cp "dist/SG Haze.js" "$DEST/SG Haze.js"
echo "deployed to $DEST/SG Haze.js"
