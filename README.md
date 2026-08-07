# 🎙️ SubSync Translate

**Audio + SRT → translated SRT with the exact same segment breaks, re-timed precisely from the audio using Whisper large-v3.**

Ever have an English SRT whose timings drift from the actual audio? This tool:

1. **Transcribes your audio** with [Whisper large-v3](https://console.groq.com/docs/speech-to-text) (via Groq's free API) with **word-level timestamps**
2. **Aligns** your original SRT's segments to the transcribed words — so every subtitle keeps its **exact same break points**, but the start/end times are corrected from the real audio
3. **Translates** every segment to your chosen language (Google Translate free, or Groq LLM for higher quality)
4. Gives you a **translated SRT** + a **re-timed original SRT** to download

Two ways to use it:

| Mode | Best for | Needs |
|---|---|---|
| **🖥️ Local (recommended)** — Whisper + NLLB run on YOUR machine, no API at all | Privacy, big files, unlimited use, GPU speed | Windows + one-time model download |
| **🌐 Online** — [soubickdas-lab.github.io/subsync-translate](https://soubickdas-lab.github.io/subsync-translate/) | Quick use from any device | Free Groq API key |

## 🖥️ Local mode (no API, 100% offline after first run)

**Quick start:** download/clone this repo, then double-click **`start-local.bat`** — bas. Pehli baar ye khud Python + dependencies setup karega, phir browser khol dega. First run downloads Whisper large-v3 (~3 GB) + NLLB-200 translation model (~2.4 GB) — one time only.

| File | Kya karta hai |
|---|---|
| `start-local.bat` | Server start + browser open (pehli baar setup bhi khud kar leta hai) |
| `setup.bat` | Manual setup (Python + dependencies) — normally zaroorat nahi |
| `update.bat` | GitHub se latest version le aao (venv/models safe rehte hain) |
| `server.py` | FastAPI backend — transcription, alignment, translation |
| `static/index.html` | Pura local frontend (single file) |
| `requirements.txt` | Python dependencies |

- **GPU**: NVIDIA GPU ho to CUDA pe chalta hai (float16), warna CPU (int8) pe — auto-detect, auto-fallback
- **Transcription**: [faster-whisper](https://github.com/SYSTRAN/faster-whisper) large-v3 (ya turbo/medium/small/base), word timestamps ke saath — koi file-size limit nahi
- **Translation**: Meta ka [NLLB-200](https://huggingface.co/facebook/nllb-200-distilled-600M) (distilled-600M, CTranslate2 float16/int8) — 35+ languages, fully local
- Video files (mp4/mkv) bhi chalti hain — audio track khud nikal leta hai

## 🌐 Online mode (GitHub Pages)

## ✨ Features

- 🎯 **Whisper large-v3** (best) or **large-v3-turbo** (faster) — word-level timestamps
- 🔍 **Auto-detect audio language** (or pick from 30+ languages)
- 🌐 **35+ output languages** — Hindi, Bengali, Tamil, Spanish, Japanese, Arabic…
- ✂️ **Segment breaks preserved exactly** — same number of lines, same split points as your input SRT
- ⏱️ **Timings corrected from audio** — unmatched lines are smartly interpolated
- 🔀 **Two translation engines** — Google Translate (free, no key) or Groq LLM (llama-3.3-70b)
- 📦 **Large files supported** — audio over 24 MB is auto-split into chunks at silence points
- ✏️ **Editable preview** — fix any translated line before downloading
- 📄 Accepts `.srt` and `.vtt`, outputs standard `.srt`

## 🚀 Usage

1. Open the tool (GitHub Pages link above, or just open `index.html` locally)
2. Paste your **free Groq API key** — get one at [console.groq.com/keys](https://console.groq.com/keys) (stored only in your browser's localStorage)
3. Drop your **audio file** (mp3/wav/m4a/flac/ogg…) and your **subtitle file** (.srt/.vtt)
4. Pick audio language (or leave **Auto-detect**), output language, and translation engine
5. Hit **⚡ Transcribe · Re-time · Translate**
6. Review/edit the table, then **download your translated SRT**

## 🧠 How the re-timing works

- Whisper returns every spoken word with its start/end time
- Each SRT segment's words are matched against the Whisper word stream (normalized, greedy sequential matching with a lookahead window)
- Matched segments get `start = first matched word's start`, `end = last matched word's end`
- Segments with too few matches are linearly interpolated between their matched neighbors
- A final pass enforces monotonic, non-overlapping timings with a minimum duration

## 🔒 Privacy

- Your API key never leaves your browser (localStorage only)
- Audio is sent **only** to the Groq API for transcription
- Subtitle text is sent **only** to your chosen translation engine
- No analytics, no server, no storage

## 🛠️ Tech

Pure vanilla HTML/CSS/JS — zero dependencies, zero build step. Works from `file://` or any static host.

## 📄 License

MIT
