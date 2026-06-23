# Otoha — local text-to-speech reader

Read your current selection in any app, or read a note in Obsidian aloud, using
[Kokoro](https://github.com/hexgrad/kokoro) — fully local, no cloud, no license fee.

## Install (macOS, Apple Silicon)

1. Download the latest **`Otoha_*.dmg`** from
   [**Releases**](https://github.com/spacegrowth/otoha/releases/latest), open it, and
   drag **Otoha** to Applications. The Kokoro server is bundled inside the app — nothing
   else to install.
2. First launch is blocked by macOS (the app isn't notarized yet). Either:
   - **System Settings → Privacy & Security →** scroll down → **Open Anyway**, or
   - run once in Terminal: `xattr -dr com.apple.quarantine /Applications/Otoha.app`
3. Launch Otoha — it lives in the menu bar (`○` idle · spinner generating · `◉` reading).

> Apple Silicon (M-series) only for now. The one-time "Open Anyway" step is expected
> until the app is notarized.

Three parts:

- **App** (`app/`) — a Tauri menu-bar app. Bundles the Kokoro server as a sidecar,
  manages playback, and reads the current selection in any app (`⌘⌥S`) / stops (`⌘⌥X`).
- **Server** (`server/`) — a warm in-memory Kokoro HTTP server (holds the model in
  memory for low latency). Bundled into the app; also runnable standalone.
- **Obsidian plugin** (`obsidian-plugin/`) — reads the active note aloud, highlighting
  sentence-by-sentence and smooth-scrolling to follow the spoken line.

## Menu-bar indicator

Monochrome: `○` idle · `⠋⠙⠹…` (animated spinner) processing/generating · `◉` reading.

## The warm server

- Health: `curl http://127.0.0.1:8765/health`
- Reuses the Kokoro model files (`kokoro-v1.0.onnx` + `voices-v1.0.bin`) via
  `kokoro_onnx` (ONNX, no PyTorch).
- Config via environment (`OTOHA_*`, e.g. `OTOHA_LEAD_SILENCE`, `OTOHA_PORT`,
  `OTOHA_VOICE`) — see `server/tts_server.py`.

## Obsidian plugin

- Install into a vault: `obsidian-plugin/install.sh /path/to/vault`
- Tests for the pure logic (parsing, matching, scroll math): `cd obsidian-plugin && npm test`

## Layout

```
app/                 Tauri menu-bar app (Rust + minimal web UI)
server/tts_server.py warm HTTP server (holds the model in memory)
obsidian-plugin/      Obsidian plugin (main.js, no build step) + tests
```
