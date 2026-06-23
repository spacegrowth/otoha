#!/bin/bash
# Install the Otoha TTS plugin into an Obsidian vault by copying the plugin files
# into <vault>/.obsidian/plugins/otoha-tts/. Re-run after editing main.js.
#
# Usage: ./install.sh /path/to/your/vault   (or set OTOHA_VAULT)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
VAULT="${1:-$OTOHA_VAULT}"

if [ -z "$VAULT" ]; then
  echo "Pass your vault path: ./install.sh /path/to/vault  (or set OTOHA_VAULT)"
  exit 1
fi
if [ ! -d "$VAULT/.obsidian" ]; then
  echo "No .obsidian folder at: $VAULT"
  exit 1
fi

DEST="$VAULT/.obsidian/plugins/otoha-tts"
mkdir -p "$DEST"
cp "$HERE/manifest.json" "$HERE/main.js" "$HERE/styles.css" "$DEST/"
echo "Installed Otoha TTS -> $DEST"
echo "Now in Obsidian: Settings → Community plugins → enable 'Otoha TTS'"
echo "(If Restricted/Safe mode is on, turn it off first.)"
