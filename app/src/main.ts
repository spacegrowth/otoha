// Settings window (opened from the menu-bar "Settings…" item). The menu-bar app
// itself lives in src-tauri/src/lib.rs; this talks to it via Tauri commands.
import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

type Urls = { localhost: string; lan: string | null; tailscale: string | null };

const $ = (id: string) => document.getElementById(id) as HTMLElement;

const LOCAL_HINT =
  "Off — only this Mac can use the server. Safest. The menu-bar reader still works.";
const NET_HINT =
  "On — the server is reachable on the networks this Mac is joined to. There is no password, so only enable this on networks you trust.";

async function refresh() {
  const on = (await invoke("get_network_access")) as boolean;
  ($("net-toggle") as HTMLInputElement).checked = on;
  $("net-hint").textContent = on ? NET_HINT : LOCAL_HINT;
  $("urls").hidden = !on;
  if (on) await renderUrls();
}

async function renderUrls() {
  const urls = (await invoke("server_urls")) as Urls;
  const rows: Array<[string, string]> = [];
  if (urls.lan) rows.push(["LAN (same Wi-Fi)", urls.lan]);
  if (urls.tailscale) rows.push(["Tailscale (anywhere)", urls.tailscale]);
  rows.push(["This Mac only", urls.localhost]);

  const list = $("url-list");
  list.innerHTML = "";
  for (const [label, url] of rows) {
    const li = document.createElement("li");
    li.className = "url-row";
    const meta = document.createElement("div");
    meta.className = "url-meta";
    meta.innerHTML = `<span class="url-label">${label}</span><code class="url-value">${url}</code>`;
    const btn = document.createElement("button");
    btn.className = "url-copy";
    btn.textContent = "Copy";
    btn.addEventListener("click", async () => {
      await invoke("copy_text", { text: url });
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = "Copy"), 1200);
    });
    li.append(meta, btn);
    list.append(li);
  }
}

($("net-toggle") as HTMLInputElement).addEventListener("change", async (e) => {
  const enabled = (e.target as HTMLInputElement).checked;
  await invoke("set_network_access", { enabled });
  await refresh();
});

$("ts-link").addEventListener("click", (e) => {
  e.preventDefault();
  openUrl("https://tailscale.com/download");
});

invoke("app_version")
  .then((v) => ($("version").textContent = `v${v}`))
  .catch(() => {});

refresh().catch((err) => console.error("settings load failed", err));
