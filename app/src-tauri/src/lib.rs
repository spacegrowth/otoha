// Otoha — menu-bar app: manages the local Kokoro server AND reads your current
// selection in any app (⌘⌥S) / stops playback (⌘⌥X).
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;
use tauri::{
    image::Image,
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    path::BaseDirectory,
    tray::TrayIconBuilder,
    AppHandle, Manager, Wry,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

// --- Dev fallback: when no bundled sidecar is present (i.e. `tauri dev`), launch
// the server via a local Python. Paths come from the environment so no
// machine-specific path is committed (set OTOHA_PYTHON / OTOHA_SERVER for dev).
// Production uses the bundled `otoha-server` sidecar — see server_command().
fn py() -> String {
    std::env::var("OTOHA_PYTHON").unwrap_or_else(|_| "python3".to_string())
}
fn server_script() -> String {
    std::env::var("OTOHA_SERVER").unwrap_or_else(|_| "tts_server.py".to_string())
}
const PORT: &str = "8765";
const SPEAK_URL: &str = "http://127.0.0.1:8765/speak";
const HEALTH_URL: &str = "http://127.0.0.1:8765/health";
const AFPLAY: &str = "/usr/bin/afplay";

// Voice/speed are user-selectable from the tray. Keep DEFAULT_VOICE in sync with
// the server's own default (af_bella).
const DEFAULT_VOICE: &str = "af_bella";
// Full Kokoro v1.0 voice set — kept in sync with the Obsidian plugin's VOICES.
const VOICES: [&str; 28] = [
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova",
    "af_river", "af_sarah", "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
    "am_michael", "am_onyx", "am_puck", "am_santa", "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
];
const SPEEDS: [f32; 6] = [0.75, 0.9, 1.0, 1.15, 1.25, 1.5];

// "af_bella" -> "Bella (US F)" — mirrors the plugin's voiceLabel().
fn voice_label(id: &str) -> String {
    if let Some((prefix, name)) = id.split_once('_') {
        let p = prefix.as_bytes();
        if p.len() == 2 && (p[1] == b'f' || p[1] == b'm') && !name.is_empty() {
            let region = match p[0] {
                b'a' => "US".to_string(),
                b'b' => "UK".to_string(),
                c => (c as char).to_uppercase().to_string(),
            };
            let gender = if p[1] == b'f' { "F" } else { "M" };
            let mut chars = name.chars();
            let cap = chars.next().unwrap().to_uppercase().collect::<String>() + chars.as_str();
            return format!("{cap} ({region} {gender})");
        }
    }
    id.to_string()
}

struct ServerState(Mutex<Option<Child>>);
struct PlaybackState(Mutex<Option<Child>>); // the afplay child for ⌘⌥S playback
struct VoiceState(Mutex<String>);
struct SpeedState(Mutex<f32>);
// Tray check-items, kept so the menu handler can move the checkmark.
struct VoiceItems(Vec<CheckMenuItem<Wry>>);
struct SpeedItems(Vec<CheckMenuItem<Wry>>);
// Action items the UI loop enables/disables to reflect server + playback state.
struct Controls {
    speak: MenuItem<Wry>,
    stop_read: MenuItem<Wry>,
    start: MenuItem<Wry>,
    stop: MenuItem<Wry>,
}
// Obsidian control items, kept so the UI loop can relabel/enable them as the
// reader's state changes.
struct ObsControls {
    toggle: MenuItem<Wry>,
    stop: MenuItem<Wry>,
}

// User settings, persisted to the app config dir. network_access=false binds the
// server to localhost only (safe default); true binds 0.0.0.0 so other devices
// (e.g. the Obsidian plugin on a phone over LAN/Tailscale) can reach it.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct SettingsData {
    #[serde(default)]
    network_access: bool,
}
impl Default for SettingsData {
    fn default() -> Self {
        Self { network_access: false }
    }
}
struct Settings(Mutex<SettingsData>);

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("settings.json"))
}
fn load_settings(app: &AppHandle) -> SettingsData {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}
fn save_settings(app: &AppHandle, data: &SettingsData) {
    if let Some(p) = settings_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(s) = serde_json::to_string_pretty(data) {
            let _ = std::fs::write(p, s);
        }
    }
}

fn speed_label(s: f32) -> String {
    if (s - 1.0).abs() < 0.001 {
        "1× (normal)".to_string()
    } else {
        format!("{s}×")
    }
}

// Menu-bar activity that drives the status icon.
const ACT_IDLE: u8 = 0;
const ACT_PROCESSING: u8 = 1; // generating audio
const ACT_READING: u8 = 2; // playing audio
struct Activity(AtomicU8);

// Obsidian plugin playback state, pushed to us over :8766 (GET /reading etc.) so
// the menu bar mirrors the reader and offers Pause/Resume/Stop for it.
const OBS_IDLE: u8 = 0;
const OBS_PROCESSING: u8 = 1;
const OBS_READING: u8 = 2;
const OBS_PAUSED: u8 = 3;
struct ObsidianState(AtomicU8);

// Otoha listens here for the Obsidian plugin's state pushes; it sends control
// commands back to the plugin's own listener.
const STATE_PORT: u16 = 8766;
const OBS_TOGGLE_URL: &str = "http://127.0.0.1:8767/toggle";
const OBS_STOP_URL: &str = "http://127.0.0.1:8767/stop";

// Braille spinner, shown as menu-bar text while generating.
const BRAILLE: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

fn set_activity(app: &AppHandle, value: u8) {
    app.state::<Activity>().0.store(value, Ordering::Relaxed);
}

// Listen for the Obsidian plugin's state pushes: GET /reading|/processing|/paused|
// /idle on :8766. Stdlib TCP — no dependency. Best-effort; if :8766 is taken we
// just log and skip.
fn start_state_server(app: AppHandle) {
    use std::io::{Read, Write};
    std::thread::spawn(move || {
        let listener = match std::net::TcpListener::bind(("127.0.0.1", STATE_PORT)) {
            Ok(l) => l,
            Err(e) => {
                log::warn!("Obsidian state listener couldn't bind :{STATE_PORT}: {e}");
                return;
            }
        };
        log::info!("listening for Obsidian state on :{STATE_PORT}");
        for stream in listener.incoming().flatten() {
            let mut stream = stream;
            let mut buf = [0u8; 512];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            // first line: "GET /reading HTTP/1.1"
            let path = req
                .lines()
                .next()
                .and_then(|l| l.split_whitespace().nth(1))
                .unwrap_or("/");
            let state = parse_obs_state(path);
            app.state::<ObsidianState>().0.store(state, Ordering::Relaxed);
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
        }
    });
}

// Send a control command (toggle / stop) to the Obsidian plugin's listener.
fn obsidian_cmd(url: &str) {
    let _ = ureq::get(url)
        .timeout(std::time::Duration::from_millis(500))
        .call();
}

// Map a pushed request path (e.g. "/reading") to an Obsidian state.
fn parse_obs_state(path: &str) -> u8 {
    match path
        .trim_start_matches('/')
        .split(|c| c == '?' || c == ' ')
        .next()
    {
        Some("reading") => OBS_READING,
        Some("processing") => OBS_PROCESSING,
        Some("paused") => OBS_PAUSED,
        _ => OBS_IDLE,
    }
}

// Is the Obsidian plugin's command listener (:8767) reachable? If not, Obsidian
// isn't running, so any reading/paused state we're holding is stale.
fn obsidian_alive() -> bool {
    use std::net::{TcpStream, ToSocketAddrs};
    "127.0.0.1:8767"
        .to_socket_addrs()
        .ok()
        .and_then(|mut addrs| addrs.next())
        .map(|addr| TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(300)).is_ok())
        .unwrap_or(false)
}

// Decide the next Obsidian state given the current one and whether Obsidian is
// still alive. When it quits (even mid-pause) it can't always tell us, so a
// stale active state must fall back to idle.
fn next_obs_state(current: u8, alive: bool) -> u8 {
    if current != OBS_IDLE && !alive {
        OBS_IDLE
    } else {
        current
    }
}

// ---- server process management ---------------------------------------------
// Truth for "is a server running" is the port answering /health, NOT the child
// handle — otherwise a server we didn't spawn (e.g. a dev leftover) is invisible
// and Start would spawn a duplicate that crashes on bind ([Errno 48]).
fn server_up() -> bool {
    ureq::get(HEALTH_URL)
        .timeout(std::time::Duration::from_millis(400))
        .call()
        .map(|r| r.status() == 200)
        .unwrap_or(false)
}

fn start_server(app: &AppHandle) -> bool {
    if server_up() {
        return true; // already serving :8765 — don't spawn a second one
    }
    let state = app.state::<ServerState>();
    let mut guard = state.0.lock().unwrap();
    // A child we spawned may still be loading the model (health not 200 yet).
    if let Some(child) = guard.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            return true; // still starting up
        }
        *guard = None; // previous attempt exited; fall through and respawn
    }
    match server_command(app).spawn() {
        Ok(child) => {
            log::info!("spawned Kokoro server (pid {})", child.id());
            *guard = Some(child);
            true
        }
        Err(e) => {
            log::error!("failed to spawn server: {e}");
            false
        }
    }
}

// Build the command that launches the TTS server. Production: the bundled
// `otoha-server` sidecar sitting next to our executable. Dev (no sidecar):
// `python tts_server.py` via OTOHA_PYTHON / OTOHA_SERVER. Model files come from
// the app's bundled resources when present, otherwise from the environment.
fn server_command(app: &AppHandle) -> Command {
    // Production: the bundled onedir server at Resources/otoha-server/otoha-server.
    // (onedir, not onefile — libs stay unpacked so the first inference isn't ~10x
    // slower from per-launch extraction + Gatekeeper rescans.)
    let bundled = app
        .path()
        .resolve("otoha-server/otoha-server", BaseDirectory::Resource)
        .ok()
        .filter(|p| p.exists());
    let mut cmd = match bundled {
        Some(bin) => Command::new(bin),
        None => {
            let mut c = Command::new(py());
            c.arg(server_script());
            c
        }
    };
    cmd.env("OTOHA_PORT", PORT);
    // Bind host follows the user's network-access setting: localhost only (safe
    // default) or 0.0.0.0 to let other devices (phone Obsidian over LAN/Tailscale)
    // reach it. There is no auth — only enable network access on trusted networks.
    let network = app.state::<Settings>().0.lock().unwrap().network_access;
    cmd.env("OTOHA_HOST", if network { "0.0.0.0" } else { "127.0.0.1" });
    if let Ok(model) = app
        .path()
        .resolve("models/kokoro-v1.0.onnx", BaseDirectory::Resource)
    {
        if model.exists() {
            cmd.env("OTOHA_MODEL", &model);
            if let Ok(voices) = app
                .path()
                .resolve("models/voices-v1.0.bin", BaseDirectory::Resource)
            {
                cmd.env("OTOHA_VOICES", voices);
            }
        }
    }
    cmd
}

fn stop_server(state: &ServerState) {
    let mut guard = state.0.lock().unwrap();
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    // Also clear any orphan holding the port (e.g. one we didn't spawn).
    let _ = Command::new("sh")
        .arg("-c")
        .arg("lsof -ti:8765 | xargs kill -9 2>/dev/null")
        .status();
}

// ---- selection capture + speak ---------------------------------------------
// Synthesize ⌘C as a hardware key event from OUR process. Unlike telling System
// Events to do it (which fails with "not allowed to send keystrokes" unless the
// osascript/System-Events chain is granted), this posts directly, so macOS checks
// Accessibility against Otoha itself — the grant you actually give it.
fn press_cmd_c() {
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    let kc_c: core_graphics::event::CGKeyCode = 8; // 'c'
    let src = || CGEventSource::new(CGEventSourceStateID::CombinedSessionState);
    if let (Ok(s1), Ok(s2)) = (src(), src()) {
        if let (Ok(down), Ok(up)) = (
            CGEvent::new_keyboard_event(s1, kc_c, true),
            CGEvent::new_keyboard_event(s2, kc_c, false),
        ) {
            down.set_flags(CGEventFlags::CGEventFlagCommand);
            up.set_flags(CGEventFlags::CGEventFlagCommand);
            down.post(CGEventTapLocation::HID);
            std::thread::sleep(std::time::Duration::from_millis(8));
            up.post(CGEventTapLocation::HID);
        }
    }
}

// ⌘⌥S fires while ⌘ and ⌥ are physically held; if we send ⌘C right then, the app
// sees ⌘⌥C (not a copy). Wait (briefly) for the user to release the modifiers so
// the synthesized ⌘C lands clean.
fn wait_modifiers_released() {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceFlagsState(state: i32) -> u64;
    }
    // command | option | control | shift
    const MODS: u64 = 0x10_0000 | 0x8_0000 | 0x4_0000 | 0x2_0000;
    for _ in 0..50 {
        // 0 = kCGEventSourceStateCombinedSessionState
        if unsafe { CGEventSourceFlagsState(0) } & MODS == 0 {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

// Clipboard-safe: snapshot, set a sentinel, simulate ⌘C, wait for the pasteboard
// to actually change, read the selection, then restore the original clipboard.
// Read the selected text straight from the focused UI element via the
// Accessibility API — no synthesized keystroke, no clipboard, no focus/modifier
// dependence. Returns None for apps that don't expose AXSelectedText (some
// web/Electron views), where the ⌘C clipboard path is the fallback.
fn read_selected_text_ax() -> Option<String> {
    use accessibility_sys::{
        kAXErrorSuccess, kAXFocusedUIElementAttribute, kAXSelectedTextAttribute,
        AXUIElementCopyAttributeValue, AXUIElementCreateSystemWide, AXUIElementRef,
    };
    use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
    use core_foundation::string::{CFString, CFStringRef};

    unsafe {
        let system_wide: AXUIElementRef = AXUIElementCreateSystemWide();
        if system_wide.is_null() {
            return None;
        }
        let focus_attr = CFString::new(kAXFocusedUIElementAttribute);
        let mut focused: CFTypeRef = std::ptr::null();
        let err =
            AXUIElementCopyAttributeValue(system_wide, focus_attr.as_concrete_TypeRef(), &mut focused);
        CFRelease(system_wide as CFTypeRef);
        if err != kAXErrorSuccess || focused.is_null() {
            log::info!("AX: focused-element err={err}");
            return None;
        }

        let sel_attr = CFString::new(kAXSelectedTextAttribute);
        let mut sel: CFTypeRef = std::ptr::null();
        let err2 = AXUIElementCopyAttributeValue(
            focused as AXUIElementRef,
            sel_attr.as_concrete_TypeRef(),
            &mut sel,
        );
        CFRelease(focused);
        if err2 != kAXErrorSuccess || sel.is_null() {
            // -25205 unsupported (no AXSelectedText), -25212 no value (no selection)
            log::info!("AX: selected-text err={err2}");
            return None;
        }
        let text = CFString::wrap_under_create_rule(sel as CFStringRef).to_string();
        log::info!("AX: selected-text {} chars", text.trim().len());
        if text.trim().is_empty() {
            None
        } else {
            Some(text)
        }
    }
}

fn capture_selection() -> Option<String> {
    // Preferred path: ask macOS what's selected directly.
    if let Some(t) = read_selected_text_ax() {
        return Some(t);
    }
    // Fallback for apps that don't expose AXSelectedText: clipboard via ⌘C.
    let mut cb = arboard::Clipboard::new().ok()?;
    let saved = cb.get_text().ok();
    let sentinel = "__otoha_capture__";
    let _ = cb.set_text(sentinel.to_string());

    wait_modifiers_released(); // so the synthesized ⌘C isn't merged with held ⌘⌥
    press_cmd_c(); // synthesize ⌘C from our own process (Accessibility only)

    let mut result = None;
    for _ in 0..30 {
        std::thread::sleep(std::time::Duration::from_millis(20));
        if let Ok(cur) = cb.get_text() {
            if cur != sentinel && !cur.is_empty() {
                result = Some(cur);
                break;
            }
        }
    }
    match saved {
        Some(s) => {
            let _ = cb.set_text(s);
        }
        None => {
            let _ = cb.set_text(String::new());
        }
    }
    result
}

fn synth(text: &str, voice: &str, speed: f32) -> Option<Vec<u8>> {
    let body =
        serde_json::json!({ "text": text, "voice": voice, "speed": speed, "pad": 0.25 }).to_string();
    let resp = match ureq::post(SPEAK_URL)
        .set("Content-Type", "application/json")
        .send_string(&body)
    {
        Ok(r) => r,
        Err(e) => {
            log::error!("synth request failed (voice={voice}, speed={speed}): {e}");
            return None;
        }
    };
    let mut bytes = Vec::new();
    if let Err(e) = resp.into_reader().read_to_end(&mut bytes) {
        log::error!("reading synth response failed: {e}");
        return None;
    }
    Some(bytes)
}

fn stop_playback(state: &PlaybackState) {
    let mut guard = state.0.lock().unwrap();
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn play_wav(path: &Path, state: &PlaybackState) {
    stop_playback(state);
    if let Ok(child) = Command::new(AFPLAY).arg(path).spawn() {
        *state.0.lock().unwrap() = Some(child);
    }
}

fn is_playing(state: &PlaybackState) -> bool {
    let mut guard = state.0.lock().unwrap();
    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(Some(_)) => {
                *guard = None;
                false
            }
            _ => true,
        }
    } else {
        false
    }
}

// Does macOS currently trust this process for Accessibility? (Required for the
// synthesized ⌘C to be delivered.)
fn accessibility_trusted() -> bool {
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }
    unsafe { AXIsProcessTrusted() }
}

// Full ⌘⌥S flow, off the main thread so the shortcut handler returns immediately.
fn speak_selection(app: AppHandle) {
    std::thread::spawn(move || {
        let trusted = accessibility_trusted();
        let text = match capture_selection() {
            Some(t) if !t.trim().is_empty() => t,
            _ => {
                log::info!("speak: capture empty (accessibility_trusted={trusted})");
                return;
            }
        };
        set_activity(&app, ACT_PROCESSING); // spinner while generating
        let voice = app.state::<VoiceState>().0.lock().unwrap().clone();
        let speed = *app.state::<SpeedState>().0.lock().unwrap();
        log::info!("speak: {} chars, voice={voice}, speed={speed}", text.len());
        let wav = match synth(&text, &voice, speed) {
            Some(w) => w,
            None => {
                set_activity(&app, ACT_IDLE);
                return;
            }
        };
        let path = std::env::temp_dir().join("otoha-last.wav");
        if let Err(e) = std::fs::write(&path, &wav) {
            log::error!("failed to write temp wav {path:?}: {e}");
            set_activity(&app, ACT_IDLE);
            return;
        }
        play_wav(&path, &app.state::<PlaybackState>());
        set_activity(&app, ACT_READING); // playing (auto-clears when afplay ends)
    });
}

// ---- misc helpers ----------------------------------------------------------
fn lan_ip() -> Option<String> {
    for iface in ["en0", "en1"] {
        if let Ok(out) = Command::new("ipconfig").args(["getifaddr", iface]).output() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    None
}

// Tailscale assigns addresses in 100.64.0.0/10 (CGNAT range).
fn is_tailscale_ip(ip: &str) -> bool {
    let mut parts = ip.split('.');
    let octet = |p: &mut std::str::Split<char>| p.next().and_then(|s| s.parse::<u8>().ok());
    let (a, b, c, d) = (
        octet(&mut parts),
        octet(&mut parts),
        octet(&mut parts),
        octet(&mut parts),
    );
    parts.next().is_none() && matches!((a, b, c, d), (Some(100), Some(64..=127), Some(_), Some(_)))
}

fn tailscale_ip() -> Option<String> {
    // 1) Ask the Tailscale CLI, trying the common install locations (standalone
    //    app, Homebrew, App Store CLI symlink, anything on PATH).
    let candidates = [
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
        "tailscale",
    ];
    for bin in candidates {
        if let Ok(out) = Command::new(bin).args(["ip", "-4"]).output() {
            if out.status.success() {
                if let Some(ip) = String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .map(str::trim)
                    .find(|l| is_tailscale_ip(l))
                {
                    return Some(ip.to_string());
                }
            }
        }
    }
    // 2) CLI not found / no luck — scan interfaces for a 100.64.0.0/10 address.
    //    Works regardless of how Tailscale was installed, as long as it's up.
    if let Ok(out) = Command::new("ifconfig").output() {
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if let Some(rest) = line.trim().strip_prefix("inet ") {
                if let Some(ip) = rest.split_whitespace().next() {
                    if is_tailscale_ip(ip) {
                        return Some(ip.to_string());
                    }
                }
            }
        }
    }
    None
}

fn copy_to_clipboard(text: &str) {
    if let Ok(mut cb) = arboard::Clipboard::new() {
        let _ = cb.set_text(text.to_string());
    }
}

fn url_for(ip: &str) -> String {
    format!("http://{ip}:{PORT}")
}

fn speak_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT), Code::KeyS) // ⌘⌥S
}
fn stop_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT), Code::KeyX) // ⌘⌥X
}

// Check the updater endpoint; if a newer signed release exists, install + restart.
// Runs off the menu thread. With a placeholder endpoint this just logs a miss.
fn check_for_updates(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_updater::UpdaterExt;
        let updater = match app.updater() {
            Ok(u) => u,
            Err(e) => {
                log::error!("updater init failed: {e}");
                return;
            }
        };
        match updater.check().await {
            Ok(Some(update)) => {
                log::info!(
                    "update available: {} -> {}",
                    update.current_version,
                    update.version
                );
                match update.download_and_install(|_, _| {}, || {}).await {
                    Ok(_) => {
                        log::info!("update installed; restarting");
                        app.restart();
                    }
                    Err(e) => log::error!("update install failed: {e}"),
                }
            }
            Ok(None) => log::info!("no update available (up to date)"),
            Err(e) => log::warn!("update check failed: {e}"),
        }
    });
}

// ---- commands invoked from the settings window -----------------------------
#[tauri::command]
fn get_network_access(app: AppHandle) -> bool {
    app.state::<Settings>().0.lock().unwrap().network_access
}

#[tauri::command]
fn set_network_access(app: AppHandle, enabled: bool) {
    {
        let state = app.state::<Settings>();
        let mut g = state.0.lock().unwrap();
        g.network_access = enabled;
        let data = g.clone();
        drop(g);
        save_settings(&app, &data);
    }
    log::info!("network access set to {enabled}; restarting server");
    // Rebind the server on the new host.
    stop_server(&app.state::<ServerState>());
    start_server(&app);
}

#[derive(serde::Serialize)]
struct ServerUrls {
    localhost: String,
    lan: Option<String>,
    tailscale: Option<String>,
}

#[tauri::command]
fn server_urls() -> ServerUrls {
    ServerUrls {
        localhost: url_for("127.0.0.1"),
        lan: lan_ip().map(|ip| url_for(&ip)),
        tailscale: tailscale_ip().map(|ip| url_for(&ip)),
    }
}

#[tauri::command]
fn copy_text(text: String) {
    copy_to_clipboard(&text);
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            // Writes to ~/Library/Logs/com.otoha.app/Otoha.log (file_name None ->
            // named after the app) and stdout in dev. clear_targets() first so we
            // don't end up with the plugin's default LogDir *plus* ours (double lines).
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir { file_name: None },
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut == &speak_shortcut() {
                        speak_selection(app.clone());
                    } else if shortcut == &stop_shortcut() {
                        stop_playback(&app.state::<PlaybackState>());
                        set_activity(app, ACT_IDLE);
                    }
                })
                .build(),
        )
        .manage(ServerState(Mutex::new(None)))
        .manage(PlaybackState(Mutex::new(None)))
        .manage(Activity(AtomicU8::new(ACT_IDLE)))
        .manage(ObsidianState(AtomicU8::new(OBS_IDLE)))
        .manage(VoiceState(Mutex::new(DEFAULT_VOICE.to_string())))
        .manage(SpeedState(Mutex::new(1.0)))
        .manage(Settings(Mutex::new(SettingsData::default())))
        .invoke_handler(tauri::generate_handler![
            get_network_access,
            set_network_access,
            server_urls,
            copy_text,
            app_version,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let handle = app.handle();
            log::info!("Otoha started (v{})", env!("CARGO_PKG_VERSION"));

            // Load persisted settings before the server auto-starts (so it binds
            // to the right host).
            *app.state::<Settings>().0.lock().unwrap() = load_settings(handle);

            // global hotkeys (need Accessibility permission to send ⌘C)
            if let Err(e) = app.global_shortcut().register(speak_shortcut()) {
                log::error!("failed to register ⌘⌥S: {e}");
            }
            if let Err(e) = app.global_shortcut().register(stop_shortcut()) {
                log::error!("failed to register ⌘⌥X: {e}");
            }

            // ---- tray menu ----
            let speak = MenuItem::with_id(app, "speak", "Speak selection  ⌘⌥S", true, None::<&str>)?;
            let stop_read = MenuItem::with_id(app, "stop_read", "Stop reading  ⌘⌥X", false, None::<&str>)?;

            // Obsidian reader controls (enabled only while the reader is active).
            let obs_toggle =
                MenuItem::with_id(app, "obs_toggle", "Pause Obsidian", false, None::<&str>)?;
            let obs_stop =
                MenuItem::with_id(app, "obs_stop", "Stop Obsidian", false, None::<&str>)?;

            let copy_local =
                MenuItem::with_id(app, "copy_local", "Copy localhost URL", true, None::<&str>)?;
            let copy_lan = MenuItem::with_id(app, "copy_lan", "Copy LAN URL", true, None::<&str>)?;
            let copy_ts =
                MenuItem::with_id(app, "copy_ts", "Copy Tailscale URL", true, None::<&str>)?;
            let copy_menu =
                Submenu::with_items(app, "Copy server URL", true, &[&copy_local, &copy_lan, &copy_ts])?;

            // Voice + speed pickers (checkmark tracks the current choice).
            let voice_items: Vec<CheckMenuItem<Wry>> = VOICES
                .iter()
                .map(|id| {
                    CheckMenuItem::with_id(
                        app,
                        format!("voice:{id}"),
                        voice_label(id),
                        true,
                        *id == DEFAULT_VOICE,
                        None::<&str>,
                    )
                })
                .collect::<Result<_, _>>()?;
            let voice_refs: Vec<&dyn IsMenuItem<Wry>> =
                voice_items.iter().map(|i| i as &dyn IsMenuItem<Wry>).collect();
            let voice_menu = Submenu::with_items(app, "Voice", true, &voice_refs)?;

            let speed_items: Vec<CheckMenuItem<Wry>> = SPEEDS
                .iter()
                .map(|s| {
                    CheckMenuItem::with_id(
                        app,
                        format!("speed:{s}"),
                        speed_label(*s),
                        true,
                        (*s - 1.0).abs() < 0.001,
                        None::<&str>,
                    )
                })
                .collect::<Result<_, _>>()?;
            let speed_refs: Vec<&dyn IsMenuItem<Wry>> =
                speed_items.iter().map(|i| i as &dyn IsMenuItem<Wry>).collect();
            let speed_menu = Submenu::with_items(app, "Speed", true, &speed_refs)?;

            // Initial enabled states; the UI loop keeps them in sync from here on.
            let start = MenuItem::with_id(app, "start", "Start server", false, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "Stop server", true, None::<&str>)?;
            let open_log = MenuItem::with_id(app, "open_log", "Open log", true, None::<&str>)?;
            let check_update =
                MenuItem::with_id(app, "check_update", "Check for Updates…", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Otoha", true, None::<&str>)?;
            // Distinct separator instances — a single menu-item handle can only
            // occupy one slot in a native menu, so reusing one drops neighbors.
            let sep1 = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let sep3 = PredefinedMenuItem::separator(app)?;
            let sep4 = PredefinedMenuItem::separator(app)?;

            let menu = Menu::with_items(
                app,
                &[
                    &speak, &stop_read, &obs_toggle, &obs_stop, &sep1, &voice_menu,
                    &speed_menu, &sep2, &start, &stop, &sep3, &copy_menu, &open_log, &check_update,
                    &settings, &sep4, &quit,
                ],
            )?;

            app.manage(VoiceItems(voice_items));
            app.manage(SpeedItems(speed_items));
            app.manage(Controls {
                speak: speak.clone(),
                stop_read: stop_read.clone(),
                start: start.clone(),
                stop: stop.clone(),
            });
            app.manage(ObsControls {
                toggle: obs_toggle.clone(),
                stop: obs_stop.clone(),
            });

            // Template menu-bar icons (black → recolored by macOS for light/dark).
            let icon_idle = Image::from_bytes(include_bytes!("../icons/status/idle.png"))?;
            let icon_off = Image::from_bytes(include_bytes!("../icons/status/off.png"))?;
            let icon_read: Vec<Image> = vec![
                Image::from_bytes(include_bytes!("../icons/status/read_0.png"))?,
                Image::from_bytes(include_bytes!("../icons/status/read_1.png"))?,
                Image::from_bytes(include_bytes!("../icons/status/read_2.png"))?,
                Image::from_bytes(include_bytes!("../icons/status/read_3.png"))?,
                Image::from_bytes(include_bytes!("../icons/status/read_4.png"))?,
                Image::from_bytes(include_bytes!("../icons/status/read_5.png"))?,
                Image::from_bytes(include_bytes!("../icons/status/read_6.png"))?,
                Image::from_bytes(include_bytes!("../icons/status/read_7.png"))?,
            ];

            TrayIconBuilder::with_id("main")
                .icon(icon_off.clone())
                .icon_as_template(true)
                .tooltip("Otoha — Kokoro server")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "speak" => speak_selection(app.clone()),
                        "stop_read" => {
                            stop_playback(&app.state::<PlaybackState>());
                            set_activity(app, ACT_IDLE);
                        }
                        "obs_toggle" => obsidian_cmd(OBS_TOGGLE_URL),
                        "obs_stop" => obsidian_cmd(OBS_STOP_URL),
                        "start" => {
                            start_server(app);
                        }
                        "stop" => stop_server(&app.state::<ServerState>()),
                        "quit" => {
                            stop_playback(&app.state::<PlaybackState>());
                            stop_server(&app.state::<ServerState>());
                            app.exit(0);
                        }
                        "open_log" => {
                            if let Ok(dir) = app.path().app_log_dir() {
                                let path = dir.join("Otoha.log");
                                if let Err(e) = Command::new("open").arg(&path).status() {
                                    log::error!("failed to open log {path:?}: {e}");
                                }
                            }
                        }
                        "settings" => {
                            if let Some(win) = app.get_webview_window("main") {
                                // Accessory apps don't foreground windows on show();
                                // switch to Regular so the settings window comes up.
                                #[cfg(target_os = "macos")]
                                let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                        "check_update" => check_for_updates(app.clone()),
                        "copy_local" => copy_to_clipboard(&url_for("127.0.0.1")),
                        "copy_lan" => {
                            if let Some(ip) = lan_ip() {
                                copy_to_clipboard(&url_for(&ip));
                            }
                        }
                        "copy_ts" => {
                            if let Some(ip) = tailscale_ip() {
                                copy_to_clipboard(&url_for(&ip));
                            }
                        }
                        id if id.starts_with("voice:") => {
                            let v = id.trim_start_matches("voice:").to_string();
                            *app.state::<VoiceState>().0.lock().unwrap() = v;
                            for it in &app.state::<VoiceItems>().0 {
                                let _ = it.set_checked(it.id().as_ref() == id);
                            }
                        }
                        id if id.starts_with("speed:") => {
                            if let Ok(s) = id.trim_start_matches("speed:").parse::<f32>() {
                                *app.state::<SpeedState>().0.lock().unwrap() = s;
                            }
                            for it in &app.state::<SpeedItems>().0 {
                                let _ = it.set_checked(it.id().as_ref() == id);
                            }
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Closing the settings window should hide it (back to menu-bar-only),
            // not quit the app. Revert to Accessory so the Dock icon goes away.
            if let Some(win) = app.get_webview_window("main") {
                let w = win.clone();
                let h = handle.clone();
                win.on_window_event(move |ev| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                        api.prevent_close();
                        let _ = w.hide();
                        #[cfg(target_os = "macos")]
                        let _ = h.set_activation_policy(tauri::ActivationPolicy::Accessory);
                    }
                });
            }

            start_server(handle);
            start_state_server(handle.clone()); // receive Obsidian playback state on :8766

            // Drive the menu-bar icon: animated spinner while generating, waves while
            // reading, plain speaker when idle, muted speaker when the server is off.
            let h = handle.clone();
            std::thread::spawn(move || {
                let mut frame = 0usize;
                let mut last_key = String::new();
                let mut last_state: Option<(bool, bool)> = None; // (server running, playing)
                let mut last_obs: Option<u8> = None;
                let mut running = false; // cached health probe (refreshed ~1/s)
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(110));
                    frame = frame.wrapping_add(1);
                    let mut act = h.state::<Activity>().0.load(Ordering::Relaxed);
                    let playing = is_playing(&h.state::<PlaybackState>());
                    // playback finished on its own -> back to idle
                    if act == ACT_READING && !playing {
                        h.state::<Activity>().0.store(ACT_IDLE, Ordering::Relaxed);
                        act = ACT_IDLE;
                    }
                    // Probe the port ~once per second (cheap localhost GET, but not 9x/s).
                    if frame % 9 == 0 || last_state.is_none() {
                        running = server_up();
                    }

                    // Reflect server + playback state in the action items.
                    if last_state != Some((running, playing)) {
                        let c = h.state::<Controls>();
                        let _ = c.start.set_enabled(!running);
                        let _ = c.stop.set_enabled(running);
                        let _ = c.speak.set_enabled(running && !playing);
                        let _ = c.stop_read.set_enabled(playing);
                        last_state = Some((running, playing));
                    }

                    // Obsidian reader state (pushed over :8766) -> menu items. If
                    // Obsidian quit while active (even paused), it can't always tell
                    // us, so verify its listener is alive ~once/sec and clear stale
                    // state to idle.
                    let mut obs = h.state::<ObsidianState>().0.load(Ordering::Relaxed);
                    if obs != OBS_IDLE && frame % 9 == 0 {
                        let fixed = next_obs_state(obs, obsidian_alive());
                        if fixed != obs {
                            log::info!("Obsidian unreachable — clearing stale menu state");
                            h.state::<ObsidianState>().0.store(fixed, Ordering::Relaxed);
                            obs = fixed;
                        }
                    }
                    if last_obs != Some(obs) {
                        let oc = h.state::<ObsControls>();
                        let active = obs != OBS_IDLE;
                        let _ = oc.toggle.set_enabled(active);
                        let _ = oc.stop.set_enabled(active);
                        let _ = oc.toggle.set_text(if obs == OBS_PAUSED {
                            "Resume Obsidian"
                        } else {
                            "Pause Obsidian"
                        });
                        last_obs = Some(obs);
                    }

                    // Icon reflects the app's own playback OR Obsidian's.
                    let eff_act = if act == ACT_PROCESSING || obs == OBS_PROCESSING {
                        ACT_PROCESSING
                    } else if act == ACT_READING || obs == OBS_READING {
                        ACT_READING
                    } else {
                        ACT_IDLE
                    };

                    let tray = match h.tray_by_id("main") {
                        Some(t) => t,
                        None => continue,
                    };
                    if eff_act == ACT_PROCESSING {
                        // braille spinner as menu-bar text (no icon)
                        let g = BRAILLE[frame % BRAILLE.len()];
                        let key = format!("p{g}");
                        if key != last_key {
                            if !last_key.starts_with('p') {
                                let _ = tray.set_icon(None::<Image>); // leave text mode
                            }
                            let _ = tray.set_title(Some(g));
                            last_key = key;
                        }
                    } else {
                        let (key, img) = match eff_act {
                            ACT_READING => {
                                let i = frame % icon_read.len();
                                (format!("read{i}"), icon_read[i].clone())
                            }
                            _ => {
                                if running {
                                    ("idle".to_string(), icon_idle.clone())
                                } else {
                                    ("off".to_string(), icon_off.clone())
                                }
                            }
                        };
                        if key != last_key {
                            if last_key.starts_with('p') {
                                let _ = tray.set_title(None::<&str>); // clear the spinner text
                            }
                            let _ = tray.set_icon(Some(img));
                            last_key = key;
                        }
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_obs_state_maps_paths() {
        assert_eq!(parse_obs_state("/reading"), OBS_READING);
        assert_eq!(parse_obs_state("/processing"), OBS_PROCESSING);
        assert_eq!(parse_obs_state("/paused"), OBS_PAUSED);
        assert_eq!(parse_obs_state("/idle"), OBS_IDLE);
        assert_eq!(parse_obs_state("/bogus"), OBS_IDLE);
    }

    // The reported bug: quitting Obsidian while paused must clear the menu state.
    #[test]
    fn obsidian_quit_clears_active_state() {
        assert_eq!(next_obs_state(OBS_PAUSED, false), OBS_IDLE);
        assert_eq!(next_obs_state(OBS_READING, false), OBS_IDLE);
        assert_eq!(next_obs_state(OBS_PROCESSING, false), OBS_IDLE);
    }

    #[test]
    fn obsidian_alive_preserves_state() {
        assert_eq!(next_obs_state(OBS_PAUSED, true), OBS_PAUSED);
        assert_eq!(next_obs_state(OBS_READING, true), OBS_READING);
    }

    #[test]
    fn idle_is_unaffected() {
        assert_eq!(next_obs_state(OBS_IDLE, false), OBS_IDLE);
        assert_eq!(next_obs_state(OBS_IDLE, true), OBS_IDLE);
    }
}
