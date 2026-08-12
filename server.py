"""
SubSync Translate — 100% LOCAL backend.

FastAPI server:
  - Whisper (faster-whisper, large-v3) transcription with word timestamps — GPU if available
  - SRT segment ↔ whisper-word alignment (breaks preserved, timings corrected)
  - Local translation with NLLB-200-distilled-600M (CTranslate2) — no external API

Run:  python server.py   (or start-local.bat)
"""

import glob
import json
import os
import re
import sys
import tempfile
import threading
import time
import unicodedata
import uuid
import webbrowser
from pathlib import Path

BASE = Path(__file__).resolve().parent
MODELS_DIR = BASE / "models"
MODELS_DIR.mkdir(exist_ok=True)

# --- make pip-installed CUDA DLLs (nvidia-cublas-cu12 / nvidia-cudnn-cu12) visible ---
def _add_cuda_dll_dirs():
    if os.name != "nt":
        return
    import sysconfig
    sp = sysconfig.get_paths()["purelib"]
    dirs = glob.glob(os.path.join(sp, "nvidia", "*", "bin"))
    for p in dirs:
        try:
            os.add_dll_directory(p)
        except OSError:
            pass
    # ctranslate2 resolves CUDA DLLs via PATH, not the add_dll_directory list
    if dirs:
        os.environ["PATH"] = os.pathsep.join(dirs) + os.pathsep + os.environ.get("PATH", "")

_add_cuda_dll_dirs()

import ctranslate2  # noqa: E402
import requests  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import FastAPI, File, Form, Request, UploadFile  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

PORT = 8756
NLLB_HF = "facebook/nllb-200-distilled-600M"
NLLB_DIR = MODELS_DIR / "nllb-200-distilled-600M-ct2"

try:
    CUDA = ctranslate2.get_cuda_device_count() > 0
except Exception:
    CUDA = False
DEVICE = "cuda" if CUDA else "cpu"

# ---------------- language maps ----------------

# UI/Whisper ISO code -> NLLB FLORES-200 code
FLORES = {
    "en": "eng_Latn", "hi": "hin_Deva", "bn": "ben_Beng", "ta": "tam_Taml",
    "te": "tel_Telu", "ml": "mal_Mlym", "mr": "mar_Deva", "gu": "guj_Gujr",
    "kn": "kan_Knda", "pa": "pan_Guru", "ur": "urd_Arab", "ne": "npi_Deva",
    "si": "sin_Sinh", "es": "spa_Latn", "fr": "fra_Latn", "de": "deu_Latn",
    "it": "ita_Latn", "pt": "por_Latn", "ru": "rus_Cyrl", "ja": "jpn_Jpan",
    "ko": "kor_Hang", "zh": "zho_Hans", "zh-CN": "zho_Hans", "zh-TW": "zho_Hant",
    "ar": "arb_Arab", "id": "ind_Latn", "vi": "vie_Latn", "th": "tha_Thai",
    "tr": "tur_Latn", "nl": "nld_Latn", "pl": "pol_Latn", "uk": "ukr_Cyrl",
    "fa": "pes_Arab", "ms": "zsm_Latn", "fil": "tgl_Latn", "tl": "tgl_Latn",
    "sw": "swh_Latn",
}

# ---------------- model cache (lazy, one at a time) ----------------

_model_lock = threading.Lock()
_whisper_models = {}
_nllb = {"translator": None, "tokenizer": None}


def get_whisper(size, log):
    with _model_lock:
        if size in _whisper_models:
            return _whisper_models[size]
        from faster_whisper import WhisperModel
        compute = "float16" if CUDA else "int8"
        log(f"Loading Whisper '{size}' on {DEVICE} ({compute}) — first time downloads the model…")
        try:
            m = WhisperModel(size, device=DEVICE, compute_type=compute,
                             download_root=str(MODELS_DIR / "whisper"))
        except Exception as e:
            if CUDA:
                log(f"GPU load failed ({e}) — falling back to CPU int8.")
                m = WhisperModel(size, device="cpu", compute_type="int8",
                                 download_root=str(MODELS_DIR / "whisper"))
            else:
                raise
        _whisper_models.clear()  # keep memory bounded: one whisper model at a time
        _whisper_models[size] = m
        log("Whisper model ready.")
        return m


def get_nllb(log):
    with _model_lock:
        if _nllb["translator"] is not None:
            return _nllb["translator"], _nllb["tokenizer"]

        if not (NLLB_DIR / "model.bin").exists():
            log("First run: downloading + converting NLLB-200 translation model (~2.4 GB download, one time)…")
            from ctranslate2.converters import TransformersConverter
            conv = TransformersConverter(NLLB_HF, load_as_float16=True)
            conv.convert(str(NLLB_DIR), quantization="float16", force=True)
            log("NLLB conversion done.")

        log(f"Loading NLLB translator on {DEVICE}…")
        compute = "float16" if CUDA else "int8"
        try:
            tr = ctranslate2.Translator(str(NLLB_DIR), device=DEVICE, compute_type=compute)
        except Exception as e:
            log(f"GPU load failed ({e}) — falling back to CPU int8.")
            tr = ctranslate2.Translator(str(NLLB_DIR), device="cpu", compute_type="int8")

        from transformers import AutoTokenizer
        tok = AutoTokenizer.from_pretrained(NLLB_HF, cache_dir=str(MODELS_DIR / "hf"))
        _nllb["translator"], _nllb["tokenizer"] = tr, tok
        log("Translator ready.")
        return tr, tok


# ---------------- subtitle parsing / helpers ----------------

TIME_RE = re.compile(r"^(?:(\d+):)?(\d+):(\d+)[.,](\d{1,3})$")


def parse_time(t):
    m = TIME_RE.match(t.strip())
    if not m:
        raise ValueError(f"bad timestamp: {t}")
    h = int(m.group(1) or 0)
    return h * 3600 + int(m.group(2)) * 60 + int(m.group(3)) + int(m.group(4).ljust(3, "0")) / 1000.0


def parse_subtitle(raw):
    text = raw.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    if text.strip().startswith("WEBVTT"):
        text = re.sub(r"^WEBVTT[^\n]*\n", "", text)
    segs = []
    for block in re.split(r"\n\s*\n", text):
        lines = [l.strip() for l in block.split("\n") if l.strip()]
        if not lines:
            continue
        i = 0
        if "-->" not in lines[i]:
            i += 1
        if i >= len(lines) or "-->" not in lines[i]:
            continue
        a, b = lines[i].split("-->")
        start = parse_time(a)
        end = parse_time(b.strip().split()[0])
        body = "\n".join(lines[i + 1:])
        body = re.sub(r"<[^>]+>", "", body)
        body = re.sub(r"\{\\[^}]*\}", "", body).strip()
        if not body:
            continue
        segs.append({"index": len(segs) + 1, "start": start, "end": end, "text": body})
    return segs


def norm_word(w):
    w = unicodedata.normalize("NFKD", w.lower())
    return "".join(c for c in w if unicodedata.category(c)[0] in ("L", "N"))


# ---------------- alignment ----------------

def align_segments(segments, words):
    ww = [dict(w, norm=norm_word(w["word"])) for w in words]
    ww = [w for w in ww if w["norm"]]

    s_words = []
    for si, seg in enumerate(segments):
        for raw in seg["text"].split():
            n = norm_word(raw)
            if n:
                s_words.append((n, si))

    WINDOW = 18
    seg_matches = [[] for _ in segments]
    wi = 0
    for n, si in s_words:
        for j in range(wi, min(wi + WINDOW, len(ww))):
            if ww[j]["norm"] == n:
                seg_matches[si].append(ww[j])
                wi = j + 1
                break

    total_words = total_matched = matched_count = 0
    for i, seg in enumerate(segments):
        m = seg_matches[i]
        wc = len([1 for r in seg["text"].split() if norm_word(r)]) or 1
        need = 1 if wc <= 3 else max(2, -(-wc * 3 // 10))  # ceil(0.3*wc)
        total_words += wc
        total_matched += len(m)
        if len(m) >= need:
            seg["newStart"] = m[0]["start"]
            seg["newEnd"] = m[-1]["end"]
            seg["matched"] = True
            matched_count += 1
        else:
            seg["matched"] = False

    _interpolate_unmatched(segments)
    _enforce_monotonic(segments)
    return {
        "matchedSegments": matched_count,
        "totalSegments": len(segments),
        "wordMatchRatio": (total_matched / total_words) if total_words else 0,
    }


def _interpolate_unmatched(segments):
    n = len(segments)
    i = 0
    while i < n:
        if segments[i]["matched"]:
            i += 1
            continue
        j = i
        while j + 1 < n and not segments[j + 1]["matched"]:
            j += 1
        prev = segments[i - 1] if i > 0 else None
        nxt = segments[j + 1] if j + 1 < n else None

        if prev and nxt:
            old_lo, old_hi = prev["end"], nxt["start"]
            new_lo, new_hi = prev["newEnd"], nxt["newStart"]
            scale = max(new_hi - new_lo, 0) / max(old_hi - old_lo, 0.001)
            for k in range(i, j + 1):
                segments[k]["newStart"] = new_lo + (segments[k]["start"] - old_lo) * scale
                segments[k]["newEnd"] = new_lo + (segments[k]["end"] - old_lo) * scale
        elif nxt:
            d = nxt["newStart"] - nxt["start"]
            for k in range(i, j + 1):
                segments[k]["newStart"] = max(0.0, segments[k]["start"] + d)
                segments[k]["newEnd"] = max(0.0, segments[k]["end"] + d)
        elif prev:
            d = prev["newEnd"] - prev["end"]
            for k in range(i, j + 1):
                segments[k]["newStart"] = segments[k]["start"] + d
                segments[k]["newEnd"] = segments[k]["end"] + d
        else:
            for k in range(i, j + 1):
                segments[k]["newStart"] = segments[k]["start"]
                segments[k]["newEnd"] = segments[k]["end"]
        i = j + 1


def _enforce_monotonic(segments):
    MIN_DUR = 0.30
    prev_end = 0.0
    for seg in segments:
        ns = seg.get("newStart")
        if ns is None or ns < prev_end:
            seg["newStart"] = prev_end
        orig_dur = max(seg["end"] - seg["start"], MIN_DUR)
        ne = seg.get("newEnd")
        if ne is None or ne <= seg["newStart"]:
            seg["newEnd"] = seg["newStart"] + orig_dur
        if seg["newEnd"] - seg["newStart"] < MIN_DUR:
            seg["newEnd"] = seg["newStart"] + MIN_DUR
        prev_end = seg["newEnd"]


# ---------------- translation ----------------

def translate_texts(texts, src_iso, tgt_iso, log, on_progress):
    tr, tok = get_nllb(log)
    src = FLORES.get(src_iso, "eng_Latn")
    tgt = FLORES.get(tgt_iso, "hin_Deva")
    tok.src_lang = src

    out = []
    BATCH = 16
    beam = 4 if DEVICE == "cuda" else 2
    total = len(texts)
    for i in range(0, total, BATCH):
        batch = texts[i:i + BATCH]
        src_tokens = [tok.convert_ids_to_tokens(tok.encode(t)) for t in batch]
        results = tr.translate_batch(
            src_tokens,
            target_prefix=[[tgt]] * len(batch),
            beam_size=beam,
            max_decoding_length=256,
        )
        for r in results:
            hyp = r.hypotheses[0]
            if hyp and hyp[0] == tgt:
                hyp = hyp[1:]
            out.append(tok.decode(tok.convert_tokens_to_ids(hyp), skip_special_tokens=True).strip())
        on_progress(min(i + BATCH, total), total)
    return out


# ---------------- DNS fallback (kuch ISP DNS kuch domains resolve nahi karte) ----------------

import socket  # noqa: E402

_orig_getaddrinfo = socket.getaddrinfo
_doh_cache = {}


def _doh_resolve(host):
    """Resolve via DNS-over-HTTPS (IP-direct endpoints, system DNS bypass)."""
    if host in _doh_cache:
        return _doh_cache[host]
    endpoints = [
        ("https://8.8.8.8/resolve", {}),
        ("https://1.1.1.1/dns-query", {"accept": "application/dns-json"}),
    ]
    for url, headers in endpoints:
        try:
            r = requests.get(url, params={"name": host, "type": "A"},
                             headers=headers, timeout=8)
            for ans in r.json().get("Answer", []):
                if ans.get("type") == 1:
                    _doh_cache[host] = ans["data"]
                    return ans["data"]
        except Exception:
            continue
    return None


def _patched_getaddrinfo(host, *args, **kwargs):
    try:
        return _orig_getaddrinfo(host, *args, **kwargs)
    except socket.gaierror:
        if isinstance(host, str) and not host.replace(".", "").isdigit():
            ip = _doh_resolve(host)
            if ip:
                return _orig_getaddrinfo(ip, *args, **kwargs)
        raise


socket.getaddrinfo = _patched_getaddrinfo

# ---------------- TTS dubbing (ai33.pro / OpenSpeaker) ----------------

AI33 = "https://api.ai33.pro"

# target UI code -> whisper language code (for re-transcribing the dubbed audio)
WHISPER_CODE = {"zh-CN": "zh", "zh-TW": "zh", "fil": "tl"}


def tts_generate(job_id, segments, tts, log, prog):
    """Generate dubbed audio from translated segments via ai33.pro, download it."""
    text = "\n".join(s["translated"] for s in segments)
    log(f"TTS request bhej rahe hain ({len(text)} chars, voice: {tts['voice']})…")
    r = requests.post(
        f"{AI33}/v3/text-to-speech",
        headers={"xi-api-key": tts["key"]},
        data={
            "text": text,
            "voice_id": tts["voice"],
            "speed": tts.get("speed", "1"),
            "with_transcript": "true",
            "file_name": f"subsync_{job_id}",
        },
        timeout=120,
    )
    d = r.json()
    if not d.get("success"):
        raise RuntimeError(f"TTS request failed ({r.status_code}): {json.dumps(d)[:300]}")
    task_id = d["task_id"]
    log(f"TTS task bana: {task_id} — audio generate ho raha hai…")

    deadline = time.time() + 30 * 60
    while True:
        time.sleep(5)
        if time.time() > deadline:
            raise RuntimeError("TTS timeout (30 min)")
        t = requests.get(f"{AI33}/v1/task/{task_id}",
                         headers={"xi-api-key": tts["key"]}, timeout=30).json()
        status = t.get("status")
        p = t.get("progress") or 0
        prog(70 + p * 0.12, f"TTS audio ban raha hai… {p}%")
        if status == "done":
            break
        if status == "error":
            raise RuntimeError("TTS failed: " + str(t.get("error_message")))

    meta = t.get("metadata") or {}
    audio_url = meta.get("audio_url")
    if not audio_url:
        raise RuntimeError("TTS done but no audio_url in metadata")

    out_dir = BASE / "outputs"
    out_dir.mkdir(exist_ok=True)
    ext = os.path.splitext(audio_url.split("?")[0])[1] or ".mp3"
    out_path = out_dir / f"{job_id}{ext}"
    prog(83, "Dubbed audio download ho raha hai…")
    with requests.get(audio_url, stream=True, timeout=300) as resp:
        resp.raise_for_status()
        with open(out_path, "wb") as f:
            for chunk in resp.iter_content(1 << 20):
                f.write(chunk)
    log(f"Dubbed audio mila: {out_path.name} ({out_path.stat().st_size // 1024} KB)")
    return out_path, meta


def align_dub(segments, model, audio_path, tgt_lang, log, prog):
    """Transcribe the dubbed audio locally and re-time the translated segments to it."""
    wcode = WHISPER_CODE.get(tgt_lang, tgt_lang.split("-")[0])
    prog(85, "Dubbed audio transcribe ho raha hai (naye SRT timings ke liye)…")
    try:
        gen, info = model.transcribe(str(audio_path), language=wcode,
                                     word_timestamps=True, beam_size=5)
    except ValueError:
        gen, info = model.transcribe(str(audio_path), language=None,
                                     word_timestamps=True, beam_size=5)
    duration = max(getattr(info, "duration", 0) or 0, 0.001)
    words = []
    for seg in gen:
        for w in (seg.words or []):
            words.append({"word": w.word, "start": w.start, "end": w.end})
        prog(85 + min(seg.end / duration, 1.0) * 11,
             f"Dubbed audio transcribe… {min(seg.end, duration):.0f}s / {duration:.0f}s")
    log(f"Dubbed audio: {len(words)} words, {duration:.0f}s.")

    # align translated text against the dubbed audio's words
    dub_segs = [{"start": s["newStart"], "end": s["newEnd"], "text": s["translated"]}
                for s in segments]
    stats = align_segments(dub_segs, words)
    for s, d in zip(segments, dub_segs):
        s["dubStart"] = d["newStart"]
        s["dubEnd"] = d["newEnd"]
        s["dubMatched"] = d["matched"]
    log(f"Dubbed SRT: {stats['matchedSegments']}/{stats['totalSegments']} segments "
        f"audio se timed (word match {stats['wordMatchRatio'] * 100:.0f}%).")
    return stats, duration


# ---------------- job management ----------------

JOBS = {}
_job_lock = threading.Lock()  # one heavy job at a time


def run_job(job_id, audio_path, srt_text, src_lang, tgt_lang, model_size, tts=None):
    job = JOBS[job_id]

    def log(msg):
        job["log"].append(f"[{time.strftime('%H:%M:%S')}] {msg}")

    def prog(p, msg=None):
        job["progress"] = round(p, 1)
        if msg:
            job["message"] = msg

    try:
        with _job_lock:
            job["status"] = "running"
            prog(2, "Parsing subtitles…")
            segments = parse_subtitle(srt_text)
            if not segments:
                raise ValueError("No cues found in the subtitle file")
            log(f"Parsed {len(segments)} subtitle segments.")

            prog(4, "Loading Whisper model (first run downloads it)…")
            model = get_whisper(model_size, log)

            prog(12, "Transcribing audio…")
            lang_arg = None if src_lang == "auto" else src_lang
            gen, info = model.transcribe(
                audio_path,
                language=lang_arg,
                word_timestamps=True,
                vad_filter=True,
                temperature=0.0,
                beam_size=5,
            )
            duration = max(getattr(info, "duration", 0) or 0, 0.001)
            detected = getattr(info, "language", None) or (src_lang if src_lang != "auto" else "en")
            log(f"Audio language: {detected} "
                f"(p={getattr(info, 'language_probability', 0):.2f}), duration {duration:.0f}s.")

            words = []
            transcript_parts = []
            for seg in gen:
                transcript_parts.append(seg.text.strip())
                for w in (seg.words or []):
                    words.append({"word": w.word, "start": w.start, "end": w.end})
                prog(12 + min(seg.end / duration, 1.0) * 43,
                     f"Transcribing… {min(seg.end, duration):.0f}s / {duration:.0f}s")
            transcript = " ".join(transcript_parts)
            log(f"Whisper returned {len(words)} words.")

            prog(56, "Aligning subtitle segments to audio…")
            stats = align_segments(segments, words)
            log(f"Aligned {stats['matchedSegments']}/{stats['totalSegments']} segments directly "
                f"(word match {stats['wordMatchRatio'] * 100:.0f}%); rest interpolated.")

            prog(58, "Loading translation model (first run downloads it)…")
            texts = [re.sub(r"\s*\n\s*", " ", s["text"]).strip() for s in segments]
            translate_end = 68 if tts else 98
            translated = translate_texts(
                texts, detected, tgt_lang, log,
                lambda done, total: prog(60 + done / total * (translate_end - 60),
                                         f"Translating… {done}/{total} lines"),
            )
            for s, t in zip(segments, translated):
                s["translated"] = t

            dub = None
            if tts:
                try:
                    audio_out, meta = tts_generate(job_id, segments, tts, log, prog)
                    dub_stats, dub_dur = align_dub(segments, model, audio_out, tgt_lang, log, prog)
                    dub = {
                        "file": f"/api/outputs/{audio_out.name}",
                        "filename": audio_out.name,
                        "duration": dub_dur,
                        "stats": dub_stats,
                        "provider_srt_url": meta.get("srt_url"),
                        "provider_audio_url": meta.get("audio_url"),
                    }
                except Exception as e:
                    log(f"TTS dubbing FAIL hua (translation results fir bhi ready hain): {e}")
                    dub = {"error": str(e)}

            job["result"] = {
                "language": detected,
                "stats": stats,
                "segments": segments,
                "transcript": transcript,
                "dub": dub,
            }
            prog(100, "Done ✔")
            job["status"] = "done"
            log("Done.")
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)
        log(f"ERROR: {e}")
    finally:
        try:
            os.unlink(audio_path)
        except OSError:
            pass


# ---------------- FastAPI app ----------------

app = FastAPI(title="SubSync Translate (local)")


@app.middleware("http")
async def no_cache_html(request, call_next):
    # HTML kabhi cache na ho — update ke baad "purana page" wali problem khatam
    response = await call_next(request)
    if "text/html" in response.headers.get("content-type", ""):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


@app.get("/api/info")
def api_info():
    return {"device": DEVICE, "cuda": CUDA, "version": "1.6-local"}


# ---- live system stats (CPU / RAM / GPU / VRAM, in %) ----

_nvml = {"handle": None, "tried": False}


def _gpu_stats():
    if not _nvml["tried"]:
        _nvml["tried"] = True
        try:
            import pynvml
            pynvml.nvmlInit()
            _nvml["handle"] = pynvml.nvmlDeviceGetHandleByIndex(0)
            _nvml["mod"] = pynvml
        except Exception:
            _nvml["handle"] = None
    h = _nvml["handle"]
    if h is None:
        return None, None
    try:
        pynvml = _nvml["mod"]
        util = pynvml.nvmlDeviceGetUtilizationRates(h).gpu
        mem = pynvml.nvmlDeviceGetMemoryInfo(h)
        return util, round(mem.used / mem.total * 100, 1)
    except Exception:
        return None, None


@app.get("/api/stats")
def api_stats():
    import psutil
    gpu, vram = _gpu_stats()
    return {
        "cpu": psutil.cpu_percent(interval=None),
        "ram": psutil.virtual_memory().percent,
        "gpu": gpu,
        "vram": vram,
    }


# ---- chunked upload (big files through Cloudflare's ~100 MB request limit) ----

UPLOADS = {}  # id -> {"path": str, "next": int}


@app.post("/api/upload/init")
def upload_init(filename: str = Form("audio.bin")):
    tmp_dir = BASE / "tmp"
    tmp_dir.mkdir(exist_ok=True)
    suffix = os.path.splitext(filename)[1] or ".bin"
    fd, tmp_path = tempfile.mkstemp(suffix=suffix, dir=str(tmp_dir))
    os.close(fd)
    uid = uuid.uuid4().hex[:16]
    UPLOADS[uid] = {"path": tmp_path, "next": 0}
    return {"id": uid}


@app.post("/api/upload/chunk")
async def upload_chunk(
    upload_id: str = Form(...),
    index: int = Form(...),
    chunk: UploadFile = File(...),
):
    up = UPLOADS.get(upload_id)
    if not up:
        return JSONResponse({"error": "unknown upload"}, status_code=404)
    if index != up["next"]:
        return JSONResponse({"error": f"expected chunk {up['next']}, got {index}"}, status_code=409)
    with open(up["path"], "ab") as f:
        while data := await chunk.read(1 << 20):
            f.write(data)
    up["next"] += 1
    return {"ok": True, "received": up["next"]}


@app.post("/api/jobs")
async def create_job(
    audio: UploadFile = File(None),
    srt: UploadFile = File(...),
    src_lang: str = Form("auto"),
    tgt_lang: str = Form("hi"),
    model_size: str = Form("large-v3"),
    upload_id: str = Form(None),
    tts_key: str = Form(""),
    tts_voice: str = Form(""),
    tts_speed: str = Form("1"),
):
    if upload_id:
        up = UPLOADS.pop(upload_id, None)
        if not up:
            return JSONResponse({"error": "unknown upload_id"}, status_code=404)
        tmp_path = up["path"]
    elif audio is not None:
        suffix = os.path.splitext(audio.filename or "audio.bin")[1] or ".bin"
        tmp_dir = BASE / "tmp"
        tmp_dir.mkdir(exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(suffix=suffix, dir=str(tmp_dir))
        with os.fdopen(fd, "wb") as f:
            while chunk := await audio.read(1 << 20):
                f.write(chunk)
    else:
        return JSONResponse({"error": "no audio provided"}, status_code=422)

    srt_text = (await srt.read()).decode("utf-8-sig", errors="replace")

    if model_size not in {"large-v3", "large-v3-turbo", "medium", "small", "base"}:
        model_size = "large-v3"

    tts = None
    if tts_key.strip() and tts_voice.strip():
        tts = {"key": tts_key.strip(), "voice": tts_voice.strip(), "speed": tts_speed or "1"}

    job_id = uuid.uuid4().hex[:12]
    JOBS[job_id] = {"status": "queued", "progress": 0, "message": "Queued…",
                    "log": [], "result": None, "error": None}
    threading.Thread(
        target=run_job,
        args=(job_id, tmp_path, srt_text, src_lang, tgt_lang, model_size, tts),
        daemon=True,
    ).start()
    return {"id": job_id}


@app.get("/api/outputs/{filename}")
def get_output(filename: str):
    path = (BASE / "outputs" / filename).resolve()
    if not str(path).startswith(str((BASE / "outputs").resolve())) or not path.exists():
        return JSONResponse({"error": "not found"}, status_code=404)
    return FileResponse(str(path))


@app.get("/api/tts/voices")
def tts_voices(request: Request, provider: str = "edge", q: str = "", language: str = ""):
    key = request.headers.get("x-tts-key", "")
    params = {"provider": provider, "page_size": 100}
    if q:
        params["q"] = q
    if language:
        params["language"] = language
    try:
        r = requests.get(f"{AI33}/v3/voices", headers={"xi-api-key": key},
                         params=params, timeout=30)
        return JSONResponse(r.json(), status_code=r.status_code)
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=502)


@app.get("/api/tts/credits")
def tts_credits(request: Request):
    key = request.headers.get("x-tts-key", "")
    try:
        r = requests.get(f"{AI33}/v1/credits", headers={"xi-api-key": key}, timeout=30)
        return JSONResponse(r.json(), status_code=r.status_code)
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=502)


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        return JSONResponse({"error": "unknown job"}, status_code=404)
    return job


app.mount("/", StaticFiles(directory=str(BASE / "static"), html=True), name="static")


if __name__ == "__main__":
    print(f"\n  SubSync Translate (local) — http://127.0.0.1:{PORT}")
    print(f"  Device: {DEVICE.upper()}{' (' + str(ctranslate2.get_cuda_device_count()) + ' GPU)' if CUDA else ''}\n")
    if os.environ.get("OPEN_BROWSER") == "1":
        threading.Timer(1.5, lambda: webbrowser.open(f"http://127.0.0.1:{PORT}")).start()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
