"use strict";
// Headless unit tests for Otoha TTS pure logic. No framework — run with:
//   node test/core.test.js
//
// main.js requires "obsidian" and "@codemirror/*" at load time, which don't exist
// in Node. We intercept those requires with minimal stubs (Plugin must be a real
// class because main.js does `class ... extends Plugin`). The DOM/layout behavior
// is NOT covered here (it needs Obsidian) — only the pure parsing, matching, and
// scroll-target math, which is where the bouncing-scroll bug lived.

const Module = require("module");
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") {
    return {
      Plugin: class {}, PluginSettingTab: class {}, Setting: class {},
      MarkdownView: class {}, Notice: class {}, requestUrl: () => {},
      setIcon: () => {}, Platform: { isMobile: false },
    };
  }
  if (request.startsWith("@codemirror/")) return {};
  return origLoad.call(this, request, parent, isMain);
};

const { parseSentences, cleanInline, locateSentenceInText, computeFollowTarget } = require("../main.js");

let passed = 0, failed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.error(`FAIL: ${msg}\n  expected ${e}\n  got      ${a}`); }
}
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error(`FAIL: ${msg}`); } }

// ---- locateSentenceInText: the bouncing-scroll root cause --------------------
// Duplicate/repeated text must resolve to the occurrence for THAT sentence in
// order, not the first occurrence anywhere (which made next-line targets land
// above the current line and bounce the scroll up/down).
(() => {
  // "Buy milk" appears twice; sentence 1 (second bullet) must map to the SECOND
  // occurrence, not the first. A naive indexOf(needle) returns 0 for both.
  const norm = "Buy milk Buy eggs Buy milk Buy bread";
  const needles = ["Buy milk", "Buy eggs", "Buy milk", "Buy bread"];
  eq(locateSentenceInText(norm, needles, 0), { start: 0, end: 8 }, "first 'Buy milk' -> first occurrence");
  eq(locateSentenceInText(norm, needles, 2), { start: 18, end: 26 }, "third sentence 'Buy milk' -> SECOND occurrence (was the bug)");
  // Positions must be strictly increasing across sentences (no going backward).
  let prev = -1, monotonic = true;
  for (let i = 0; i < needles.length; i++) {
    const h = locateSentenceInText(norm, needles, i);
    if (!h || h.start <= prev) monotonic = false;
    prev = h ? h.start : prev;
  }
  ok(monotonic, "sentence start offsets are strictly increasing (no backward jump)");

  // A sentence whose earlier siblings aren't rendered still resolves (fallback).
  eq(locateSentenceInText("only the last one here", ["missing", "the last one"], 1),
     { start: 5, end: 17 }, "unrendered earlier sentence -> fallback to first occurrence of target");
  eq(locateSentenceInText("nothing matches", ["nope"], 0), null, "no match -> null");
})();

// ---- computeFollowTarget: forward-only + comfort band ------------------------
(() => {
  // Viewport: top=0, height=1000. Band center 0.45 ±0.13 -> [320, 580] px.
  const base = {
    vpTop: 0, clientHeight: 1000, anchorFrac: 0.45, band: 0.13,
    maxAdvance: 0.6, scrollTop: 2000, maxScroll: 100000,
  };
  const T = (o) => computeFollowTarget({ ...base, ...o });

  // (1) BAND = hold: reading line inside the band -> no scroll at all (no jitter).
  eq(T({ curTop: 450, curBottom: 470, nextTop: 470, f: 0 }), 2000, "line inside band -> hold (no scroll)");
  // Mid-sentence but the interpolated reading point is still inside the band -> hold.
  // (lineY = 450 + 0.3*(560-450) = 483, within [320,580].)
  eq(T({ curTop: 450, curBottom: 470, nextTop: 560, f: 0.3 }), 2000,
     "mid-sentence but reading point still inside band -> hold");

  // (2) FORWARD: line sinks past band bottom (580) -> scroll down by the overflow.
  ok(T({ curTop: 650, curBottom: 670, nextTop: 670, f: 0 }) > 2000, "line below band -> scroll forward");
  eq(T({ curTop: 650, curBottom: 670, nextTop: 670, f: 0 }), 2070, "scroll exactly the overflow (650-580)");

  // (3) FORWARD-ONLY: a line ON-SCREEN but ABOVE the band must NOT scroll up.
  eq(T({ curTop: 100, curBottom: 120, nextTop: 120, f: 0 }), 2000,
     "on-screen line above band -> HOLD, never scroll backward (the user's rule)");

  // (4) Monotonic as audio advances within a sentence (never reverses).
  const a = T({ curTop: 560, curBottom: 600, nextTop: 800, f: 0 });
  const b = T({ curTop: 560, curBottom: 600, nextTop: 800, f: 0.5 });
  const c = T({ curTop: 560, curBottom: 600, nextTop: 800, f: 1 });
  ok(a <= b && b <= c, "target non-decreasing as f advances");

  // (5) Mis-resolved next ABOVE current can't scroll backward (clamped to curBottom).
  ok(T({ curTop: 650, curBottom: 670, nextTop: 100, f: 1 }) >= 2000,
     "bogus next above current -> no backward scroll");

  // (6) Page-leap cap: a next-line a full screen away is capped to maxAdvance.
  const capped = T({ curTop: 650, curBottom: 670, nextTop: 90000, f: 1 });
  const expectedLineY = 670 + 1000 * 0.6;            // curBottom + maxAdvance*vh
  eq(capped, 2000 + (expectedLineY - 580), "far next-line is capped (no sudden page leap)");

  // (7) SEEK: line off-screen ABOVE (negative y) -> reposition up to band top.
  ok(T({ curTop: -500, curBottom: -480, nextTop: -480, f: 0, scrollTop: 5000 }) < 5000,
     "line off-screen above (backward seek) -> scroll up to reveal it");

  // (8) Bounds.
  ok(T({ curTop: 9000, curBottom: 9020, nextTop: 9020, f: 0, maxScroll: 100 }) <= 100, "never exceeds maxScroll");
  ok(T({ curTop: -9000, curBottom: -8980, nextTop: -8980, f: 0, scrollTop: 10 }) >= 0, "never below 0");
})();

// ---- cleanInline: snake_case must survive (highlight-match + pronunciation) --
(() => {
  eq(cleanInline("The `created_at` / `updated_at` columns"), "The created_at / updated_at columns",
     "intra-word underscores in inline code are preserved (e.g. snake_case, was 'createdat')");
  eq(cleanInline("set _really_ important"), "set really important", "emphasis underscores still stripped");
  eq(cleanInline("__bold__ and **strong**"), "bold and strong", "double underscore / asterisk emphasis stripped");
  eq(cleanInline("call foo_bar_baz now"), "call foo_bar_baz now", "multi-underscore identifier preserved");
})();

// ---- parseSentences: bullets ------------------------------------------------
(() => {
  const md = "- Buy milk.\n- Buy eggs.\n";
  const s = parseSentences(md);
  eq(s.map((x) => x.text), ["Buy milk.", "Buy eggs."], "bullets -> one sentence each, marker stripped");
  // Offsets point at the text, not the "- " marker.
  ok(md.slice(s[0].from, s[0].to).startsWith("Buy milk"), "offset starts at text, not bullet marker");

  const num = "1. First item.\n2. Second item.\n";
  const ns = parseSentences(num);
  eq(ns.map((x) => x.text), ["First item.", "Second item."], "numbered list -> marker stripped, no empty '1.' sentence");
})();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
