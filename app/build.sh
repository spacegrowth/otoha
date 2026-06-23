#!/usr/bin/env bash
# Release build for Otoha. Strips the build machine's home path out of the
# binary (--remap-path-prefix derives from $HOME, so nothing personal is
# hardcoded here) and signs the updater bundle if the local key is present.
#
# Usage: ./build.sh           # build signed-updater unsigned-app DMG
# Apple signing/notarization: also export APPLE_SIGNING_IDENTITY, APPLE_ID,
#   APPLE_PASSWORD, APPLE_TEAM_ID before running (see README/notes).
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$PATH"

# Remove machine/username paths from embedded debug/panic metadata.
export RUSTFLAGS="--remap-path-prefix=$HOME=/otoha-build${RUSTFLAGS:+ $RUSTFLAGS}"

# Sign the auto-update artifact if the (gitignored) key is here.
if [ -f .tauri-keys/otoha.key ]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat .tauri-keys/otoha.key)"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
fi

npm run tauri build "$@"
