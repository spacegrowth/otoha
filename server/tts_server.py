#!/usr/bin/env python3
"""Otoha warm TTS server.

Holds the Kokoro ONNX model in memory so selection-flow requests are fast
(no ~300MB cold load per call). No PyTorch, no Kokoro-FastAPI.

Model/voices paths come from the environment (OTOHA_MODEL / OTOHA_VOICES); the
default looks for them next to this executable, so no machine path is hardcoded.

Endpoints:
    GET  /health        -> 200 "ok" once the model is loaded
    POST /speak         -> JSON {text, voice?, speed?, lang?, pad?} -> audio/wav
                           pad overrides the leading-silence seconds (default
                           LEAD_SILENCE); the reader sends pad=0 between
                           sentences to avoid gaps.
"""
import io
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import soundfile as sf

# kokoro_onnx imports librosa solely for librosa.effects.trim() (silence trim).
# librosa drags in llvmlite/numba/scipy/sklearn (~160MB). In the packaged build we
# exclude librosa and satisfy that one call with a tiny numpy equivalent here, so
# the import below succeeds. In dev (librosa installed) the real one is used.
try:
    import librosa  # noqa: F401
except ImportError:
    import types

    def _trim(y, top_db=60, **_):
        y = np.asarray(y)
        if y.size == 0:
            return y, np.array([0, 0])
        peak = float(np.max(np.abs(y)))
        if peak <= 0:
            return y, np.array([0, len(y)])
        thresh = peak * (10 ** (-top_db / 20.0))
        idx = np.where(np.abs(y) > thresh)[0]
        if idx.size == 0:
            return y, np.array([0, len(y)])
        start, end = int(idx[0]), int(idx[-1]) + 1
        return y[start:end], np.array([start, end])

    _lib = types.ModuleType("librosa")
    _eff = types.ModuleType("librosa.effects")
    _eff.trim = _trim
    _lib.effects = _eff
    sys.modules["librosa"] = _lib
    sys.modules["librosa.effects"] = _eff

from kokoro_onnx import Kokoro

# --- config -----------------------------------------------------------------
# Resolve model files next to the binary/script by default (no hardcoded path);
# the host app overrides via OTOHA_MODEL / OTOHA_VOICES.
BASE_DIR = os.path.dirname(
    sys.executable if getattr(sys, "frozen", False) else os.path.abspath(__file__)
)
MODEL_PATH = os.environ.get("OTOHA_MODEL", os.path.join(BASE_DIR, "kokoro-v1.0.onnx"))
VOICES_PATH = os.environ.get("OTOHA_VOICES", os.path.join(BASE_DIR, "voices-v1.0.bin"))
DEFAULT_VOICE = os.environ.get("OTOHA_VOICE", "af_bella")
# 0.0.0.0 = listen on all interfaces so other devices (phone over LAN/Tailscale)
# can reach it. Only expose on networks you trust — there is no auth. Set
# OTOHA_HOST=127.0.0.1 to restrict to this machine only.
HOST = os.environ.get("OTOHA_HOST", "127.0.0.1")
PORT = int(os.environ.get("OTOHA_PORT", "8765"))
# Leading silence (seconds) so the CoreAudio output device finishes waking up
# before speech starts — otherwise the first ~200ms of words get clipped.
LEAD_SILENCE = float(os.environ.get("OTOHA_LEAD_SILENCE", "0.35"))

print(f"[otoha] loading model: {MODEL_PATH}", flush=True)
kokoro = Kokoro(MODEL_PATH, VOICES_PATH)
print("[otoha] model loaded, server warm", flush=True)

# The ONNX inference session is not guaranteed thread-safe; serialize generation
# so concurrent requests (e.g. the reader prefetching the next sentence while the
# current one plays) can't overlap a single create() call.
_gen_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # keep the log quiet
        pass

    def do_GET(self):
        if self.path == "/health":
            self._send(200, b"ok", "text/plain")
        else:
            self._send(404, b"not found", "text/plain")

    def do_POST(self):
        if self.path != "/speak":
            self._send(404, b"not found", "text/plain")
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            text = (body.get("text") or "").strip()
            if not text:
                self._send(400, b"empty text", "text/plain")
                return
            voice = body.get("voice") or DEFAULT_VOICE
            speed = float(body.get("speed", 1.0))
            lang = body.get("lang", "en-us")
            lead = LEAD_SILENCE if body.get("pad") is None else float(body["pad"])

            with _gen_lock:
                samples, sample_rate = kokoro.create(
                    text, voice=voice, speed=speed, lang=lang
                )
            if lead > 0:
                pad = np.zeros(int(sample_rate * lead), dtype=samples.dtype)
                samples = np.concatenate([pad, samples])
            buf = io.BytesIO()
            sf.write(buf, samples, sample_rate, format="WAV", subtype="PCM_16")
            self._send(200, buf.getvalue(), "audio/wav")
        except Exception as e:  # surface errors to the client instead of hanging
            self._send(500, str(e).encode(), "text/plain")

    def _send(self, code, payload, content_type):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def _warmup():
    # The first ONNX inference pays a one-time ~5-7s init (graph optimization,
    # thread pool, memory arena). Do a throwaway synth at startup so the user's
    # first real request is fast. Runs in the background; holds the gen lock so a
    # real request that arrives mid-warmup simply waits for it instead of paying
    # the cost itself.
    try:
        with _gen_lock:
            kokoro.create("Warming up.", voice=DEFAULT_VOICE, speed=1.0, lang="en-us")
        print("[otoha] warmup complete", flush=True)
    except Exception as e:
        print(f"[otoha] warmup skipped: {e}", flush=True)


if __name__ == "__main__":
    threading.Thread(target=_warmup, daemon=True).start()
    print(f"[otoha] listening on http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
