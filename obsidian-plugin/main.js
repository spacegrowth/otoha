"use strict";
// Otoha TTS — read the active note aloud via the local warm Kokoro server
// (http://127.0.0.1:8765) and highlight the spoken sentence IN PLACE in the
// editor (CodeMirror 6 decorations). Plain JS, no build step.

const { Plugin, PluginSettingTab, Setting, MarkdownView, Notice, requestUrl, setIcon, Platform } = require("obsidian");

// CodeMirror is provided by Obsidian at runtime. Load defensively so that, if
// it's ever unavailable, audio still plays (highlight is best-effort on top).
let CMview, CMstate, setActive;
try {
  CMview = require("@codemirror/view");
  CMstate = require("@codemirror/state");
  setActive = CMstate.StateEffect.define(); // payload: {from,to} | null
} catch (e) {
  CMview = CMstate = setActive = null;
}

const SERVER = "http://127.0.0.1:8765"; // base; /speak is appended in synthToUrl
const DEFAULT_VOICE = "af_bella";

const VOICES = [
  "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore",
  "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
  "am_onyx", "am_puck", "am_santa",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
  "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
];

const SPEED_OPTIONS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

const DEFAULT_SETTINGS = {
  voice: DEFAULT_VOICE,
  speed: 1.0,
  highlightColor: "",
  engine: "",                         // "" = pick by platform on first load
  serverUrl: "http://127.0.0.1:8765",
};

// "af_bella" -> "Bella (US F)" for a readable voice picker
function voiceLabel(id) {
  const m = id.match(/^([a-z])([fm])_(.+)$/);
  if (!m) return id;
  const region = { a: "US", b: "UK" }[m[1]] || m[1].toUpperCase();
  const name = m[3].charAt(0).toUpperCase() + m[3].slice(1);
  return `${name} (${region} ${m[2] === "f" ? "F" : "M"})`;
}

const SAMPLE_TEXT = "The quick brown fox jumps over the lazy dog.";
const PREVIEW_SCROLL_EVENTS = ["touchstart", "touchmove", "wheel", "scroll"];
const FOLLOW_ANCHOR = 0.45;      // center of the comfort band (0=top, 1=bottom of viewport)
const FOLLOW_BAND = 0.13;        // half-height of the band; while the line is inside, we don't scroll
const FOLLOW_MAX_ADVANCE = 0.6;  // cap the next-line distance to this × viewport (stops sudden page leaps)
const FOLLOW_EASE = 0.22;        // per-frame fraction of the remaining distance to close (smaller = softer)

// POST text to the warm server and return a playable object URL for the WAV.
// `url` is the server BASE (host:port); we append the /speak endpoint, tolerating
// a trailing slash or an explicit /speak the user may have typed.
async function synthToUrl({ url, text, voice, speed, pad }) {
  let base = (url || SERVER).replace(/\/+$/, "");
  if (base.endsWith("/speak")) base = base.slice(0, -"/speak".length);
  const res = await requestUrl({
    url: base + "/speak",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice, speed, pad }),
    throw: true,
  });
  return URL.createObjectURL(new Blob([res.arrayBuffer], { type: "audio/wav" }));
}

// ---- markdown -> sentences WITH source offsets ------------------------------
function cleanInline(s) {
  return s
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[*~]+/g, "")
    // Strip `_` only when it's markdown emphasis (at a word boundary), never an
    // intra-word underscore like `created_at` — otherwise snake_case identifiers
    // become "createdat", which mis-pronounces AND breaks reading-view matching.
    .replace(/(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Length-preserving blanking of '.!?' inside spans that should never end a
// sentence (links, inline code, wikilinks) — e.g. the dot in "http://x.com".
// Length is unchanged so source offsets stay valid.
function maskTerminators(raw) {
  const blank = (s) => s.replace(/[.!?]/g, " ");
  return raw
    .replace(/!\[[^\]]*\]\([^)]*\)/g, blank) // images
    .replace(/\[[^\]]*\]\([^)]*\)/g, blank)  // [text](url)
    .replace(/\[\[[^\]]*\]\]/g, blank)       // [[wikilinks]]
    .replace(/`[^`]*`/g, blank);             // `inline code`
}

// Returns [{from, to, text}] where from/to are character offsets into `md`
// (matching CodeMirror document positions) and text is the cleaned spoken form.
function parseSentences(md) {
  const out = [];
  const N = md.length;

  let start = 0;
  const fm = md.match(/^---\n[\s\S]*?\n---\n/);
  if (fm) start = fm[0].length;

  // line table with absolute offsets
  const lines = [];
  for (let i = start; i <= N; ) {
    let nl = md.indexOf("\n", i);
    if (nl === -1) nl = N;
    lines.push({ text: md.slice(i, nl), from: i, to: nl });
    if (nl === N) break;
    i = nl + 1;
  }

  // group lines into blocks (paragraph runs + standalone heading/list/quote)
  const blocks = [];
  let pf = -1, pt = -1, hasP = false;
  const flush = () => { if (hasP) blocks.push({ from: pf, to: pt }); pf = pt = -1; hasP = false; };
  let inFence = false, fence = null;
  for (const ln of lines) {
    const t = ln.text.trim();
    const f = ln.text.match(/^\s*(```|~~~)/);
    if (f) {
      if (!inFence) { inFence = true; fence = f[1]; flush(); }
      else if (ln.text.includes(fence)) { inFence = false; fence = null; }
      continue;
    }
    if (inFence) continue;
    if (t === "") { flush(); continue; }
    const indent = ln.text.length - ln.text.trimStart().length;
    const contentFrom = ln.from + indent;
    // Standalone block = heading / list item / blockquote. Advance the block's
    // start PAST the marker so it's never part of a sentence range — otherwise a
    // numbered marker like "1." splits off as its own spoken sentence, and bullet
    // offsets point at "- " instead of the text.
    const marker = t.match(/^(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s?)/);
    if (marker) { flush(); blocks.push({ from: contentFrom + marker[0].length, to: ln.to }); }
    else { if (!hasP) { pf = contentFrom; hasP = true; } pt = ln.to; }
  }
  flush();

  // split each block into sentences, carrying offsets. We split on a
  // length-preserving MASK where '.!?' inside links / inline code / wikilinks
  // are blanked, so e.g. the dot in "http://x.com" can't end a sentence — while
  // offsets still map 1:1 onto the real source for highlighting.
  for (const b of blocks) {
    const raw = md.slice(b.from, b.to);
    const masked = maskTerminators(raw);
    const re = /[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g;
    let m;
    while ((m = re.exec(masked)) !== null) {
      let from = b.from + m.index;
      let to = from + m[0].length;
      while (from < to && /\s/.test(md[from])) from++;       // trim range edges
      while (to > from && /\s/.test(md[to - 1])) to--;
      const text = cleanInline(md.slice(from, to).replace(/\n/g, " "));
      if (text) out.push({ from, to, text });
      if (m.index === re.lastIndex) re.lastIndex++;          // guard zero-length
    }
  }
  return out;
}

// ---- pure helpers (unit-tested in test/core.test.js) -----------------------

// Find sentence `targetIdx` inside the normalized rendered text. Sentences are
// matched IN ORDER with a forward cursor, so repeated/duplicate text resolves to
// the correct (monotonically increasing) occurrence — not the first one anywhere
// in the note, which made the highlight (and the next-line scroll target) jump to
// an earlier duplicate and bounce up/down. Sentences missing from the (possibly
// virtualized) rendered text are skipped without advancing the cursor.
// Returns {start, end} as indices into `norm`, or null.
function locateSentenceInText(norm, needles, targetIdx) {
  let cursor = 0;
  for (let i = 0; i <= targetIdx; i++) {
    const needle = needles[i];
    if (!needle) { if (i === targetIdx) return null; continue; }
    const at = norm.indexOf(needle, cursor);
    if (at < 0) {
      if (i === targetIdx) {
        // Not found ahead of the cursor (earlier sentences may be unrendered):
        // fall back to the first occurrence anywhere rather than giving up.
        const fb = norm.indexOf(needle);
        return fb < 0 ? null : { start: fb, end: fb + needle.length };
      }
      continue; // earlier sentence not rendered — keep the cursor where it is
    }
    if (i === targetIdx) return { start: at, end: at + needle.length };
    cursor = at + needle.length;
  }
  return null;
}

// Pure scroll-target math for the follow loop. Returns the scrollTop to ease
// toward, built on two rules the exact-center approach lacked:
//   - FORWARD-ONLY while reading: we only scroll DOWN to follow the line. We never
//     scroll up unless the line is off-screen ABOVE (a backward seek), so there's
//     no back-and-forth from chasing a moving center.
//   - BAND, not a point: while the reading line sits inside the comfort band we
//     hold still (no jitter); we only follow once it sinks past the band's bottom.
// `o`: { curTop, curBottom, nextTop, f, scrollTop, vpTop, clientHeight,
//        anchorFrac, band, maxAdvance, maxScroll } — all in viewport px / fractions.
function computeFollowTarget(o) {
  // Next line must be below current and not absurdly far (bad match / huge gap) —
  // clamp so we can't scroll backward or leap a whole page.
  let safeNext = o.nextTop > o.curBottom ? o.nextTop : o.curBottom;
  const maxNext = o.curBottom + o.clientHeight * o.maxAdvance;
  if (safeNext > maxNext) safeNext = maxNext;
  // The reading point creeps from the current line toward the next as audio plays.
  const lineY = o.curTop + o.f * (safeNext - o.curTop);

  const bandTop = o.vpTop + o.clientHeight * (o.anchorFrac - o.band);
  const bandBottom = o.vpTop + o.clientHeight * (o.anchorFrac + o.band);

  let target = o.scrollTop;
  if (lineY > bandBottom) {
    target = o.scrollTop + (lineY - bandBottom);   // sank below band → follow down
  } else if (lineY < o.vpTop) {
    target = o.scrollTop + (lineY - bandTop);       // off-screen above (seek) → bring to band top
  } // else: on-screen within/above band → hold (no scroll, no backward drift)

  return Math.max(0, Math.min(target, o.maxScroll));
}

// ---- CodeMirror highlight field --------------------------------------------
function buildHighlightField() {
  const { StateField } = CMstate;
  const { Decoration, EditorView } = CMview;
  return StateField.define({
    create() { return Decoration.none; },
    update(deco, tr) {
      deco = deco.map(tr.changes);
      for (const e of tr.effects) {
        if (e.is(setActive)) {
          deco = e.value
            ? Decoration.set([Decoration.mark({ class: "otoha-inplace" }).range(e.value.from, e.value.to)])
            : Decoration.none;
        }
      }
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

// ---- playback engine (view-independent) ------------------------------------
class Reader {
  constructor({ onState, onActive }) {
    this.onState = onState;
    this.onActive = onActive;
    this.voice = DEFAULT_VOICE;
    this.speed = 1.0;
    this.engine = "kokoro";          // "kokoro" (server) | "device" (built-in TTS)
    this.serverUrl = SERVER;
    this.deviceVoice = null;         // a SpeechSynthesisVoice, or null for default
    this.synth = (typeof window !== "undefined" && window.speechSynthesis) || null;
    this.sentences = [];
    this.idx = -1;
    this.playing = false;
    this.paused = false;
    this._seq = 0;                   // invalidates in-flight playback on stop/seek
    this.cache = {};
    this.audio = new Audio();        // used by the Kokoro engine only
    this.audio.onended = () => { if (this.playing && this.engine === "kokoro") this.playFrom(this.idx + 1); };
    this.audio.onerror = () => { if (this.engine === "kokoro") this.setState("idle"); };
  }

  setState(s) { this.state = s; if (this.onState) this.onState(s); }

  load(sentences) {
    this.stop();
    this.sentences = sentences;
    this.cache = {};
    this.idx = -1;
  }

  fetchClip(i) {
    if (this.cache[i]) return this.cache[i];
    const p = synthToUrl({
      url: this.serverUrl,
      text: this.sentences[i].text,
      voice: this.voice,
      speed: this.speed,
      pad: i === 0 ? 0.25 : 0,
    });
    this.cache[i] = p;
    return p;
  }

  async playFrom(i) {
    if (i < 0 || i >= this.sentences.length) { this.stop(); return; }
    this.idx = i;
    this.playing = true;
    this.paused = false;
    if (this.onActive) this.onActive(i);
    const seq = ++this._seq;
    if (this.engine === "device") return this.playDevice(i, seq);
    return this.playKokoro(i, seq);
  }

  // Kokoro engine: fetch a WAV from the warm server, play via <audio>, prefetch.
  async playKokoro(i, seq) {
    this.setState("processing");
    let url;
    try {
      url = await this.fetchClip(i);
    } catch (e) {
      if (seq !== this._seq) return;
      this.playing = false;
      this.setState("idle");
      new Notice("Otoha: can't reach the Kokoro server at " + this.serverUrl);
      return;
    }
    if (i + 1 < this.sentences.length) this.fetchClip(i + 1); // 1-ahead prefetch
    if (!this.playing || this.idx !== i || seq !== this._seq) return; // canceled/seeked
    this.audio.src = url;
    this.setState("reading");
    try { await this.audio.play(); } catch (e) { /* interrupted by next src */ }
  }

  // Device engine: speak the sentence with the OS built-in voice (Web Speech).
  // No server, works offline on mobile. Advances on utterance end.
  playDevice(i, seq) {
    if (!this.synth) {
      this.playing = false;
      this.setState("idle");
      new Notice("Otoha: this device has no built-in speech synthesis");
      return;
    }
    this.setState("reading"); // built-in TTS has negligible generation latency
    const u = new SpeechSynthesisUtterance(this.sentences[i].text);
    u.rate = this.speed;
    if (this.deviceVoice) u.voice = this.deviceVoice;
    u.onend = () => { if (seq === this._seq && this.playing && !this.paused) this.playFrom(this.idx + 1); };
    u.onerror = () => { if (seq === this._seq) this.setState("idle"); };
    this.synth.cancel();   // clear any queued/:speaking utterance first
    this.synth.speak(u);
  }

  toggle() {
    if (this.engine === "device") return this.toggleDevice();
    if (this.playing) {
      this.audio.pause();
      this.playing = false;
      this.paused = true;
      this.setState("idle");
    } else if (this.idx >= 0 && this.audio.src &&
               this.audio.currentTime > 0 && this.audio.currentTime < this.audio.duration) {
      this.playing = true;
      this.paused = false;
      this.setState("reading");
      this.audio.play();
    } else {
      this.playFrom(this.idx >= 0 ? this.idx : 0);
    }
  }

  toggleDevice() {
    if (!this.synth) return;
    if (this.playing) {
      this.synth.pause();
      this.playing = false;
      this.paused = true;
      this.setState("idle");
    } else if (this.paused) {
      this.synth.resume();
      this.playing = true;
      this.paused = false;
      this.setState("reading");
    } else {
      this.playFrom(this.idx >= 0 ? this.idx : 0);
    }
  }

  seekOffset(off) {
    const i = this.sentences.findIndex((s) => off >= s.from && off < s.to);
    if (i >= 0) this.playFrom(i);
  }

  stop() {
    this.playing = false;
    this.paused = false;
    this._seq++;                       // invalidate any in-flight utterance/fetch
    if (this.synth) this.synth.cancel();
    this.audio.pause();
    try { this.audio.currentTime = 0; } catch (e) {}
    this.setState("idle");
    if (this.onActive) this.onActive(-1);
  }
}

// ---- plugin ----------------------------------------------------------------
module.exports = class OtohaReaderPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.cm = null;        // CodeMirror EditorView of the note being read
    this.reader = new Reader({
      onState: (s) => this.updateStatus(s),
      onActive: (i) => { this.highlight(i); this.updateBar(i); },
    });
    this.reader.voice = this.settings.voice;
    this.reader.speed = this.settings.speed;
    this.reader.engine = this.settings.engine;
    this.reader.serverUrl = this.settings.serverUrl;
    this.applyHighlightColor();

    if (CMview && CMstate) {
      this.registerEditorExtension(buildHighlightField());
      const self = this;
      this.registerEditorExtension(CMview.EditorView.domEventHandlers({
        mousedown(evt, view) {
          // Only act while a read is in progress — a click from a stopped state
          // must NOT start playback (it's just a normal cursor placement).
          const active = self.reader.playing || self.reader.paused;
          if (view === self.cm && active && self.reader.sentences.length) {
            const pos = view.posAtCoords({ x: evt.clientX, y: evt.clientY });
            if (pos != null) {
              const cur = self.reader.sentences[self.reader.idx];
              // click the sentence that's playing -> pause/resume; else jump
              if (cur && pos >= cur.from && pos < cur.to) self.reader.toggle();
              else self.reader.seekOffset(pos);
            }
          }
          return false;
        },
      }));
    }

    // Monochrome status-bar controls (no colour emoji): the state glyph itself
    // is the play/pause button — ○ idle (click=play) / ◉ reading (click=pause).
    // Mobile has no status bar, so addStatusBarItem may be unavailable/null —
    // guard it so onload never throws there (the floating bar covers mobile).
    this.statusBar = this.addStatusBarItem ? this.addStatusBarItem() : null;
    if (this.statusBar) {
      this.statusBar.style.cursor = "pointer";
      this.statusBar.setAttribute("aria-label", "Otoha: play / pause");
      this.statusBar.addEventListener("click", () => this.reader.toggle());
    }

    this.statusStop = this.addStatusBarItem ? this.addStatusBarItem() : null;
    if (this.statusStop) {
      this.statusStop.setText("■ Stop");
      this.statusStop.style.cursor = "pointer";
      this.statusStop.setAttribute("aria-label", "Otoha: stop");
      this.statusStop.addEventListener("click", () => this.reader.stop());
    }

    this.createControlBar();
    this.updateStatus("idle");

    // Ribbon doubles as play/pause once a read is under way; starts the current
    // note when idle.
    this.ribbonEl = this.addRibbonIcon("play-circle", "Read current note (Otoha)", () => {
      if (this.reader.playing || this.reader.paused) this.reader.toggle();
      else this.read("note");
    });
    this.addCommand({ id: "read-note", name: "Read current note", callback: () => this.read("note") });
    this.addCommand({ id: "read-selection", name: "Read selection", callback: () => this.read("selection") });
    this.addCommand({ id: "read-cursor", name: "Read from cursor", callback: () => this.read("cursor") });
    this.addCommand({ id: "toggle", name: "Play / pause", callback: () => this.reader.toggle() });
    this.addCommand({ id: "stop", name: "Stop reading", callback: () => this.reader.stop() });
    this.addCommand({ id: "next", name: "Next sentence", callback: () => this.reader.playFrom(this.reader.idx + 1) });
    this.addCommand({ id: "prev", name: "Previous sentence", callback: () => this.reader.playFrom(this.reader.idx - 1) });

    this.addSettingTab(new OtohaSettingTab(this.app, this));
    this.startCommandServer();

    // Track the bound note's visibility across tab switches: clear the stale
    // highlight when it leaves screen, and snap to the current sentence when it
    // comes back so you land on where the reading actually is.
    const onNav = () => {
      if (!this.boundLeaf) return;
      const visible = !!this._boundView();
      if (!visible) {
        this.clearAllHighlights();
      } else if (!this._wasBoundVisible && this.reader.idx >= 0 &&
                 (this.reader.playing || this.reader.paused)) {
        this.scrollToCurrent();             // re-paint + scroll to the current sentence
      }
      this._wasBoundVisible = visible;
    };
    this.registerEvent(this.app.workspace.on("active-leaf-change", onNav));
    this.registerEvent(this.app.workspace.on("file-open", onNav));
  }

  // Reverse channel: let the Otoha menu-bar app control Obsidian playback.
  // A tiny localhost HTTP listener (desktop/Node only) exposes /stop and /toggle.
  startCommandServer() {
    try {
      const http = require("http");
      this.cmdServer = http.createServer((req, res) => {
        const u = req.url || "";
        try {
          if (u.startsWith("/stop")) this.reader.stop();
          else if (u.startsWith("/toggle")) this.reader.toggle();
        } catch (e) { /* ignore */ }
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      });
      this.cmdServer.on("error", () => {}); // port busy / unsupported — ignore
      this.cmdServer.listen(8767, "127.0.0.1");
    } catch (e) { /* no Node http available — skip reverse control */ }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.engine) {
      // First run: built-in voice on mobile (no server), Kokoro on desktop.
      this.settings.engine = Platform && Platform.isMobile ? "device" : "kokoro";
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    if (this.reader) {
      this.reader.voice = this.settings.voice;
      this.reader.speed = this.settings.speed;
      this.reader.engine = this.settings.engine;
      this.reader.serverUrl = this.settings.serverUrl;
      this.reader.cache = {}; // voice/speed/engine changed -> drop stale audio clips
    }
    this.applyHighlightColor();
  }

  applyHighlightColor() {
    const c = (this.settings.highlightColor || "").trim();
    if (c) document.body.style.setProperty("--otoha-highlight", c);
    else document.body.style.removeProperty("--otoha-highlight");
  }

  onunload() {
    this.reader.stop();
    this.clearAllHighlights();
    this.detachPreviewListeners();
    if (this.bar) this.bar.remove();
    if (this.cmdServer) { try { this.cmdServer.close(); } catch (e) {} }
  }

  // Floating, always-visible transport bar (the status bar is too easy to miss).
  createControlBar() {
    const el = document.body.createDiv({ cls: "otoha-bar" });
    el.style.display = "none";
    this.bar = el;
    const mk = (icon, title, fn) => {
      const b = el.createEl("button");
      setIcon(b, icon);
      b.setAttribute("aria-label", title);
      b.onclick = fn;
      return b;
    };
    mk("skip-back", "Previous sentence", () => this.reader.playFrom(this.reader.idx - 1));
    this.barPlay = mk("play", "Play / pause", () => this.reader.toggle());
    mk("skip-forward", "Next sentence", () => this.reader.playFrom(this.reader.idx + 1));
    mk("square", "Stop", () => this.reader.stop());
    this.barStatus = el.createSpan({ cls: "otoha-bar-status", text: "" });
    this.barStatus.style.cursor = "pointer";
    this.barStatus.setAttribute("aria-label", "Jump to current line");
    this.barStatus.addEventListener("click", () => this.scrollToCurrent());

    this.barSpeed = el.createEl("select", { cls: "otoha-bar-speed" });
    this.barSpeed.setAttribute("aria-label", "Speed");
    SPEED_OPTIONS.forEach((s) => {
      const o = this.barSpeed.createEl("option", { text: s + "×", value: String(s) });
      if (s === this.settings.speed) o.selected = true;
    });
    this.barSpeed.onchange = () => {
      this.setSpeed(parseFloat(this.barSpeed.value));
      this.barSpeed.blur(); // drop focus so it doesn't stay visually highlighted
    };
  }

  // Single source of truth for speed changes (from the bar or the settings tab):
  // persist, apply to the reader (saveSettings clears the audio cache), and keep
  // the floating-bar dropdown in sync.
  async setSpeed(v) {
    this.settings.speed = v;
    await this.saveSettings();
    if (this.barSpeed && this.barSpeed.value !== String(v)) this.barSpeed.value = String(v);
  }

  // Show the bar while a sentence is active; hide when stopped (onActive(-1)).
  updateBar(i) {
    if (this.bar) this.bar.style.display = i >= 0 ? "flex" : "none";
  }

  // mode: "note" (whole note) | "selection" (only selected text) | "cursor"
  // (from the cursor to the end). Sentence offsets are always full-document, so
  // in-place highlight and click-to-seek keep working in every mode.
  read(mode) {
    const mv = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!mv) { new Notice("Otoha: open a markdown note"); return; }
    this.clearAllHighlights();
    // "source" covers Editing + Live Preview (CodeMirror); "preview" is Reading view.
    this.renderMode = mv.getMode();
    this.cm = mv.editor.cm || null;
    this.previewEl = this.renderMode === "preview"
      ? (mv.contentEl.querySelector(".markdown-preview-view") || mv.contentEl)
      : null;
    // Bind to this note so highlighting follows the right file even if you switch
    // tabs while it reads in the background.
    this.boundLeaf = mv.leaf;
    this.boundPath = mv.file ? mv.file.path : null;
    this._wasBoundVisible = true; // we start reading the note that's on screen
    // Tap-to-seek only on desktop: on mobile it fights iOS text selection — use
    // the floating bar's Prev/Next there instead.
    if (this.renderMode === "preview") this.attachPreviewListeners();
    else this.detachPreviewListeners();

    let sentences = parseSentences(mv.editor.getValue());
    let startIdx = 0;

    if ((mode === "selection" || mode === "cursor") && this.renderMode === "preview") {
      new Notice("Otoha: selection / cursor need Editing or Live Preview — reading whole note");
    } else if (mode === "selection") {
      const a = mv.editor.posToOffset(mv.editor.getCursor("from"));
      const b = mv.editor.posToOffset(mv.editor.getCursor("to"));
      if (a === b) { new Notice("Otoha: nothing selected"); return; }
      sentences = sentences.filter((s) => s.to > a && s.from < b); // overlap selection
    } else if (mode === "cursor") {
      const off = mv.editor.posToOffset(mv.editor.getCursor());
      const i = sentences.findIndex((s) => off < s.to);
      if (i >= 0) startIdx = i;
    }

    this.reader.load(sentences);
    if (!sentences.length) { new Notice("Otoha: nothing to read"); return; }
    this.reader.playFrom(startIdx);
  }

  // Returns the bound note's view only if that leaf is still showing that file.
  _boundView() {
    const v = this.boundLeaf && this.boundLeaf.view;
    if (v && v.file && v.file.path === this.boundPath) return v;
    return null;
  }

  highlight(i) {
    // Stop / end-of-doc: clear BOTH modes (and stop the follow loop) so nothing
    // lingers if the view was recreated or the render mode changed mid-read.
    if (i < 0) { this.clearAllHighlights(); return; }
    const v = this._boundView();
    if (!v) { this.clearAllHighlights(); return; } // note not on screen — don't paint the wrong file
    // Re-acquire handles in case the view was recreated (e.g. tab switched away and back).
    this.cm = v.editor.cm || null;
    if (this.renderMode === "preview") {
      this.previewEl = v.contentEl.querySelector(".markdown-preview-view") || v.contentEl;
      this.highlightReading(i);
    } else {
      this.highlightEditor(i);
    }
    this._ensureFollow();
  }

  clearAllHighlights() {
    this._stopFollow();
    if (setActive && this.cm) { try { this.cm.dispatch({ effects: setActive.of(null) }); } catch (e) {} }
    this.removeReadingMarks();
  }

  // ---- continuous "teleprompter" auto-scroll -------------------------------
  // A single rAF loop owns the scroll while reading. Each frame it reads how far
  // the audio is through the current sentence and eases the page so that spoken
  // point holds FOLLOW_ANCHOR down the viewport — a slow continuous drag, not a
  // per-sentence jump. Because one owner drives scrollTop, anchored to the live
  // position of the line being read, it can't lurch or lose the highlight.
  _ensureFollow() { if (this._followRaf == null) this._followFrame(); }
  _stopFollow() {
    if (this._followRaf != null) { cancelAnimationFrame(this._followRaf); this._followRaf = null; }
  }
  _followFrame() {
    this._followRaf = requestAnimationFrame(() => this._followFrame());
    if (this._userScrolling()) return;          // user took over — don't fight them
    const r = this.reader;
    if (!r || r.idx < 0) return;

    // Fraction through the current sentence: real audio time for Kokoro, else 0
    // (device/Web-Speech has no progress signal, so it just centers the sentence).
    let f = 0;
    const a = r.audio;
    if (r.engine !== "device" && a && a.duration > 0 && isFinite(a.duration)) {
      f = Math.min(1, Math.max(0, a.currentTime / a.duration));
    }

    // lineY = the y we want held at the anchor. We interpolate from the START of
    // the current sentence toward the START of the NEXT one as the audio plays, so
    // over each sentence's duration the page scrolls the full distance to the next
    // line continuously — and the boundary is seamless (next line is already where
    // the current one was heading). Falls back to the sentence's own bottom when
    // the next sentence isn't laid out / found yet.
    let scroller, curTop, curBottom, nextTop;
    if (this.renderMode === "preview") {
      if (!this.previewEl) return;
      if (!this._markFirst || !this._markFirst.isConnected) {
        this.highlightReading(r.idx, true);     // re-render detached it — reattach (no scroll-nudge)
        return;
      }
      scroller = this._scroller();
      curTop = this._markFirst.getBoundingClientRect().top;
      const last = this._markLast && this._markLast.isConnected ? this._markLast : this._markFirst;
      curBottom = last.getBoundingClientRect().bottom;
      const nr = this._nextRange && this._nextRange.getBoundingClientRect();
      nextTop = nr && (nr.height || nr.width) ? nr.top : curBottom;
    } else {
      const view = this.cm;
      if (!view || !view.scrollDOM || typeof view.coordsAtPos !== "function") return;
      if (this._anchorFrom == null) return;
      const c1 = view.coordsAtPos(this._anchorFrom);
      if (!c1) return;                           // line not laid out yet
      scroller = view.scrollDOM;
      curTop = c1.top;
      const c2 = this._anchorTo != null ? view.coordsAtPos(this._anchorTo) : null;
      curBottom = c2 ? c2.bottom : c1.bottom;
      const cn = this._anchorNextFrom != null ? view.coordsAtPos(this._anchorNextFrom) : null;
      nextTop = cn ? cn.top : curBottom;
    }
    if (!scroller) return;

    const sr = scroller.getBoundingClientRect();
    const target = computeFollowTarget({
      curTop, curBottom, nextTop, f,
      scrollTop: scroller.scrollTop,
      vpTop: sr.top,
      clientHeight: scroller.clientHeight,
      anchorFrac: FOLLOW_ANCHOR,
      band: FOLLOW_BAND,
      maxAdvance: FOLLOW_MAX_ADVANCE,
      maxScroll: scroller.scrollHeight - scroller.clientHeight,
    });
    const dist = target - scroller.scrollTop;
    if (Math.abs(dist) < 0.5) return;            // settled — nothing to do this frame
    this._programmaticUntil = Date.now() + 250;  // our own scroll events aren't "user"
    scroller.scrollTop += dist * FOLLOW_EASE;
  }

  // The actual scrollable element (on mobile it may be an ancestor of previewEl).
  _scroller() {
    let el = this.previewEl;
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 4) return el;
      el = el.parentElement;
    }
    return this.previewEl;
  }

  // Editing / Live Preview: CodeMirror decoration over the source range. The
  // continuous follow loop (_followFrame) does the scrolling; here we just record
  // the sentence range it should track and make sure the line is laid out.
  highlightEditor(i) {
    if (!setActive || !this.cm) return;
    try {
      if (i < 0) { this.cm.dispatch({ effects: setActive.of(null) }); this._anchorFrom = null; this._anchorNextFrom = null; return; }
      const s = this.reader.sentences[i];
      if (!s || s.to <= s.from) return;
      this.cm.dispatch({ effects: setActive.of({ from: s.from, to: s.to }) });
      this._anchorFrom = s.from;
      this._anchorTo = s.to;
      const nx = this.reader.sentences[i + 1];
      this._anchorNextFrom = nx ? nx.from : null;
      // Far off-screen seek/start: nudge the line into the viewport once so the
      // follow loop has real coordinates to ease toward.
      if (this.cm.coordsAtPos(s.from) == null) {
        this.cm.dispatch({ effects: CMview.EditorView.scrollIntoView(s.from, { y: "center" }) });
      }
    } catch (e) { /* doc changed under us; ignore */ }
  }

  // Reading view: no CodeMirror, so find the sentence text in the rendered DOM and
  // wrap it in real <span> elements. (The CSS Custom Highlight API accumulates
  // stale ranges on iOS WebKit no matter how we clear it, so we don't use it.)
  highlightReading(i, retried) {
    if (!this.previewEl) return;
    this.removeReadingMarks();
    if (i < 0) return;
    const sent = this.reader.sentences[i];
    const range = sent && this.findReadingRange(i);
    if (!range) {
      // Lazy-rendered section not in the DOM yet: nudge scroll + retry next frame.
      // Skip the nudge while the user is scrolling — don't fight their scroll.
      if (!retried && !this._userScrolling()) {
        const scroller = this._scroller();
        if (scroller.scrollHeight > scroller.clientHeight) {
          scroller.scrollTop += Math.round(scroller.clientHeight * 0.5);
          requestAnimationFrame(() => { if (this.reader.idx === i) this.highlightReading(i, true); });
        }
      }
      return;
    }
    this.wrapRange(range);
    // Cache the first/last highlight spans so the follow loop can read the
    // sentence's vertical extent each frame without re-querying the DOM.
    const marks = this.previewEl.querySelectorAll("span.otoha-rmark");
    this._markFirst = marks[0] || null;
    this._markLast = marks.length ? marks[marks.length - 1] : null;
    // Cache a Range for the NEXT sentence so the follow loop can scroll smoothly
    // toward it (getBoundingClientRect on a Range is cheap and tracks scrolling).
    const nx = this.reader.sentences[i + 1];
    this._nextRange = nx ? this.findReadingRange(i + 1) : null;
  }

  // Wrap the in-range portion of each text node in a <span class="otoha-rmark">.
  // Returns the first span created (used for scrolling).
  wrapRange(range) {
    const walker = document.createTreeWalker(this.previewEl, NodeFilter.SHOW_TEXT);
    const inRange = [];
    let n;
    while ((n = walker.nextNode())) { if (range.intersectsNode(n)) inRange.push(n); }
    let firstSpan = null;
    for (const node of inRange) {
      const startOff = node === range.startContainer ? range.startOffset : 0;
      const endOff = node === range.endContainer ? range.endOffset : node.length;
      if (endOff <= startOff) continue;
      let target = node;
      if (endOff < target.length) target.splitText(endOff);
      if (startOff > 0) target = target.splitText(startOff);
      const span = document.createElement("span");
      span.className = "otoha-rmark";
      target.parentNode.insertBefore(span, target);
      span.appendChild(target);
      if (!firstSpan) firstSpan = span;
    }
    return firstSpan;
  }

  // Remove all reading-view highlight spans and merge the split text back.
  removeReadingMarks() {
    this._markFirst = null;
    this._markLast = null;
    this._nextRange = null;
    // Query a LIVE root: previewEl can go stale after a re-render, which would
    // leave highlight spans orphaned in the document after Stop. Fall back to the
    // whole document so no stray .otoha-rmark can survive.
    const root = this.previewEl && this.previewEl.isConnected ? this.previewEl : document;
    const marks = root.querySelectorAll("span.otoha-rmark");
    if (!marks.length) return;
    const parents = new Set();
    marks.forEach((span) => {
      const parent = span.parentNode;
      if (!parent) return;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      parents.add(parent);
    });
    parents.forEach((p) => p.normalize()); // merge split text nodes back to clean text
  }

  // Explicit "jump to the line being read" — reliable on mobile Reading view where
  // auto-follow can't always find an off-screen (unrendered) sentence. Tap the
  // progress counter in the floating bar.
  scrollToCurrent() {
    if (this.reader.idx < 0 || !this.previewEl) return;
    this._userScrollUntil = 0;   // override the scroll-suppression window
    // Jump to the sentence's estimated position (by its source offset) so its
    // section renders even when far off-screen, then paint + center it next frame.
    const sents = this.reader.sentences;
    const sent = sents[this.reader.idx];
    const scroller = this._scroller();
    const docLen = sents.length ? sents[sents.length - 1].to : 0;
    if (sent && docLen && scroller.scrollHeight > scroller.clientHeight) {
      const frac = Math.max(0, Math.min(1, sent.from / docLen));
      scroller.scrollTop = frac * (scroller.scrollHeight - scroller.clientHeight);
    }
    // Re-paint on the next frame; the follow loop takes over from this position.
    requestAnimationFrame(() => { this.highlight(this.reader.idx); });
  }

  // Build a flat map of the rendered text: nodes (with cumulative offsets), the
  // raw concatenated text, a whitespace-normalized copy, and norm->raw indices.
  // Shared by the highlighter and the click-to-seek handler.
  buildPreviewTextMap() {
    const walker = document.createTreeWalker(this.previewEl, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let raw = "";
    let n;
    while ((n = walker.nextNode())) { nodes.push({ node: n, start: raw.length }); raw += n.textContent; }
    let norm = "", map = [], sp = false;
    for (let k = 0; k < raw.length; k++) {
      const c = raw[k];
      if (/\s/.test(c)) { if (!sp) { norm += " "; map.push(k); sp = true; } }
      else { norm += c; map.push(k); sp = false; }
    }
    return { nodes, raw, norm, map };
  }

  // Locate sentence `i` among the rendered text nodes and return a DOM Range for
  // it. Order-aware (see locateSentenceInText) so duplicate text resolves to the
  // correct occurrence instead of the first one anywhere in the note.
  findReadingRange(i) {
    const sents = this.reader.sentences;
    if (!sents[i]) return null;
    const tm = this.buildPreviewTextMap();
    if (!tm.raw) return null;
    const needles = sents.map((s) => s.text.replace(/\s+/g, " ").trim());
    const hit = locateSentenceInText(tm.norm, needles, i);
    if (!hit) return null;

    const rawStart = tm.map[hit.start];
    const rawEnd = tm.map[hit.end - 1] + 1;
    const locate = (off) => tm.nodes.find((x) => off >= x.start && off < x.start + x.node.textContent.length);
    const sNode = locate(rawStart), eNode = locate(rawEnd - 1);
    if (!sNode || !eNode) return null;
    const range = document.createRange();
    range.setStart(sNode.node, rawStart - sNode.start);
    range.setEnd(eNode.node, rawEnd - eNode.start);
    return range;
  }

  // Reading-view click-to-seek: map the clicked point to a sentence and play it.
  seekReadingAt(evt) {
    if (!this.previewEl || !this.reader.sentences.length) return;
    // Only seek during an active read — don't start playback on a stray click.
    if (!this.reader.playing && !this.reader.paused) return;
    if (evt.target.closest("a, button, input, .otoha-bar")) return; // don't hijack links/controls
    let node, offset;
    if (document.caretPositionFromPoint) {
      const cp = document.caretPositionFromPoint(evt.clientX, evt.clientY);
      if (!cp) return; node = cp.offsetNode; offset = cp.offset;
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(evt.clientX, evt.clientY);
      if (!r) return; node = r.startContainer; offset = r.startOffset;
    } else return;

    const tm = this.buildPreviewTextMap();
    const hit = tm.nodes.find((x) => x.node === node);
    if (!hit) return;
    const clickedRaw = hit.start + offset;
    let clickNorm = 0;
    while (clickNorm < tm.map.length && tm.map[clickNorm] < clickedRaw) clickNorm++;

    // first sentence whose match ends after the click is the one clicked (or next)
    let cursor = 0, chosen = -1;
    for (let i = 0; i < this.reader.sentences.length; i++) {
      const needle = this.reader.sentences[i].text.replace(/\s+/g, " ").trim();
      if (!needle) continue;
      const idx = tm.norm.indexOf(needle, cursor);
      if (idx < 0) continue;
      if (clickNorm < idx + needle.length) { chosen = i; break; }
      cursor = idx + needle.length;
    }
    if (chosen >= 0) this.reader.playFrom(chosen);
  }

  attachPreviewListeners() {
    this.detachPreviewListeners();
    if (!this.previewEl) return;
    this._previewElRef = this.previewEl;
    // On manual scroll: (1) back off auto-follow so we don't yank the view, and
    // (2) re-paint the current sentence (debounced) — scrolling re-renders the
    // section and detaches the old highlight, so it must be re-attached or the
    // line you scrolled to shows no highlight until the sentence advances.
    this._onUserScroll = (e) => {
      // Ignore the scroll events our own auto-centering emits; honor genuine
      // user input (wheel / touch) immediately.
      if (e && e.type === "scroll" && Date.now() < (this._programmaticUntil || 0)) return;
      this._userScrollUntil = Date.now() + 3500;
      if (this._repaintTimer) clearTimeout(this._repaintTimer);
      this._repaintTimer = window.setTimeout(() => {
        if (this.reader.idx >= 0 && this._boundView()) this.highlightReading(this.reader.idx);
      }, 150);
    };
    PREVIEW_SCROLL_EVENTS.forEach((ev) =>
      this.previewEl.addEventListener(ev, this._onUserScroll, { passive: true }));
    // Tap-to-seek on desktop only (it fights iOS text selection on mobile).
    if (!(Platform && Platform.isMobile)) {
      this._previewClick = (evt) => this.seekReadingAt(evt);
      this.previewEl.addEventListener("click", this._previewClick);
    }
  }

  detachPreviewListeners() {
    const el = this._previewElRef;
    if (el) {
      if (this._onUserScroll) {
        PREVIEW_SCROLL_EVENTS.forEach((ev) => el.removeEventListener(ev, this._onUserScroll));
      }
      if (this._previewClick) el.removeEventListener("click", this._previewClick);
    }
    if (this._repaintTimer) { clearTimeout(this._repaintTimer); this._repaintTimer = null; }
    this._previewElRef = null;
    this._onUserScroll = null;
    this._previewClick = null;
  }

  // True while the user has scrolled recently — suppresses auto-follow scrolling.
  _userScrolling() { return Date.now() < (this._userScrollUntil || 0); }

  updateStatus(state) {
    const n = this.reader.sentences.length;
    const i = this.reader.idx;
    const prog = i >= 0 && n ? ` ${i + 1}/${n}` : "";
    const glyph = state === "processing" ? "⠿" : state === "reading" ? "◉" : "○";
    // The label names the action a click performs, so the control is obvious.
    const action = state === "reading" ? "Pause"
      : state === "processing" ? "Loading"
      : (i >= 0 ? "Resume" : "Play");
    if (this.statusBar) this.statusBar.setText(glyph + " " + action + prog);
    if (this.barStatus) this.barStatus.setText(prog.trim());
    if (this.ribbonEl) {
      const playingNow = state === "reading" || state === "processing";
      setIcon(this.ribbonEl, playingNow ? "pause-circle" : "play-circle");
    }
    // play/pause icon reflects whether audio is (or is about to be) playing
    if (this.barPlay) {
      const active = state === "reading" || state === "processing";
      setIcon(this.barPlay, active ? "pause" : "play");
    }
    this.notifyDesktop(state);
  }

  // Tell the Otoha menu-bar app (if running) about playback so the macOS
  // menu icon reflects Obsidian too. Deduped + best-effort. We show the spinner
  // only for the INITIAL generation (idle -> processing); once playback starts
  // we stay on "reading" and suppress the per-sentence processing blips so the
  // menu-bar icon doesn't flicker spinner<->◉ every few seconds.
  notifyDesktop(state) {
    let target;
    if (state === "reading") target = "reading";
    else if (state === "processing") target = this._lastDesktop === "reading" ? "reading" : "processing";
    else target = this.reader.paused ? "paused" : "idle"; // distinguish pause from stop for the menu
    if (target === this._lastDesktop) return;
    this._lastDesktop = target;
    try {
      requestUrl({ url: "http://127.0.0.1:8766/" + target, method: "GET", throw: false })
        .catch(() => {}); // Otoha menu-bar app not running — ignore
    } catch (e) { /* ignore */ }
  }

  async previewVoice() {
    try {
      const url = await synthToUrl({
        url: this.settings.serverUrl,
        text: SAMPLE_TEXT, voice: this.settings.voice, speed: this.settings.speed, pad: 0.25,
      });
      if (!this._sampleAudio) this._sampleAudio = new Audio();
      this._sampleAudio.src = url;
      this._sampleAudio.play();
    } catch (e) {
      new Notice("Otoha: server error — is the warm server running on :8765?");
    }
  }
};

// ---- settings tab ----------------------------------------------------------
class OtohaSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Engine")
      .setDesc("Kokoro = the local warm server (best quality). Device = your OS built-in voice (works offline, no server — good for phone).")
      .addDropdown((dd) => {
        dd.addOption("kokoro", "Kokoro (server)");
        dd.addOption("device", "Device (built-in)");
        dd.setValue(this.plugin.settings.engine).onChange(async (v) => {
          this.plugin.settings.engine = v;
          await this.plugin.saveSettings();
          this.display(); // show/hide engine-specific rows
        });
      });

    if (this.plugin.settings.engine === "kokoro") {
      new Setting(containerEl)
        .setName("Server URL")
        .setDesc("Where the Kokoro warm server runs. Use a LAN/Tailscale address to reach it from your phone.")
        .addText((t) =>
          t.setPlaceholder("http://127.0.0.1:8765")
            .setValue(this.plugin.settings.serverUrl)
            .onChange(async (v) => {
              this.plugin.settings.serverUrl = v.trim() || "http://127.0.0.1:8765";
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName("Voice")
      .setDesc("Kokoro voice used for reading (Kokoro engine only). Use “Play sample” to hear it.")
      .addDropdown((dd) => {
        VOICES.forEach((v) => dd.addOption(v, voiceLabel(v)));
        dd.setValue(this.plugin.settings.voice).onChange(async (v) => {
          this.plugin.settings.voice = v;
          await this.plugin.saveSettings();
        });
      })
      .addButton((b) =>
        b.setButtonText("Play sample").onClick(() => this.plugin.previewVoice())
      );

    new Setting(containerEl)
      .setName("Speed")
      .setDesc("Speech speed (applies to newly read sentences).")
      .addDropdown((dd) => {
        SPEED_OPTIONS.forEach((s) => dd.addOption(String(s), s + "×"));
        dd.setValue(String(this.plugin.settings.speed))
          .onChange((v) => this.plugin.setSpeed(parseFloat(v)));
      });

    const colorSetting = new Setting(containerEl)
      .setName("Highlight colour")
      .setDesc("Colour of the in-place sentence highlight. Reset to use your theme default.");
    if (typeof colorSetting.addColorPicker === "function") {
      colorSetting.addColorPicker((cp) =>
        cp.setValue(this.plugin.settings.highlightColor || "#ffd166").onChange(async (v) => {
          this.plugin.settings.highlightColor = v;
          await this.plugin.saveSettings();
        })
      );
    } else {
      colorSetting.addText((t) =>
        t.setPlaceholder("#ffd166 or blank")
          .setValue(this.plugin.settings.highlightColor)
          .onChange(async (v) => {
            this.plugin.settings.highlightColor = v.trim();
            await this.plugin.saveSettings();
          })
      );
    }
    colorSetting.addExtraButton((b) =>
      b.setIcon("rotate-ccw").setTooltip("Reset to theme default").onClick(async () => {
        this.plugin.settings.highlightColor = "";
        await this.plugin.saveSettings();
        this.display();
      })
    );
  }
}

// exposed for headless testing only (harmless to Obsidian, which uses the class)
module.exports.parseSentences = parseSentences;
module.exports.cleanInline = cleanInline;
module.exports.locateSentenceInText = locateSentenceInText;
module.exports.computeFollowTarget = computeFollowTarget;
