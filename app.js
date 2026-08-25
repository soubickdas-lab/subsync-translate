function droplyDoneTune(){try{const c=new (window.AudioContext||window.webkitAudioContext)();if(c.state==="suspended")c.resume().catch(()=>{});const t0=c.currentTime;const n=(f,st,d,v)=>{const o=c.createOscillator(),g=c.createGain();o.frequency.setValueAtTime(f,t0+st);g.gain.setValueAtTime(0,t0+st);g.gain.linearRampToValueAtTime(v||.15,t0+st+.015);g.gain.exponentialRampToValueAtTime(.0001,t0+st+d);o.connect(g);g.connect(c.destination);o.start(t0+st);o.stop(t0+st+d+.05)};n(523.25,0,.14);n(659.25,.1,.14);n(783.99,.2,.32,.19)}catch(e){}}
/* ============================================================
   SubSync Translate
   Audio + SRT  →  translated SRT with identical segment breaks,
   re-timed precisely from the audio via Whisper large-v3 (Groq).
   Pure client-side. No server.
   ============================================================ */

"use strict";

const REPO_URL = "https://github.com/soubickdas-lab/subsync-translate";

/* ---------------- Language lists ---------------- */

// Whisper source languages (ISO-639-1 codes Whisper accepts)
const SRC_LANGS = [
  ["auto", "🔍 Auto-detect"],
  ["en", "English"], ["hi", "Hindi"], ["ja", "Japanese"], ["ko", "Korean"],
  ["zh", "Chinese"], ["es", "Spanish"], ["fr", "French"], ["de", "German"],
  ["it", "Italian"], ["pt", "Portuguese"], ["ru", "Russian"], ["ar", "Arabic"],
  ["bn", "Bengali"], ["ur", "Urdu"], ["ta", "Tamil"], ["te", "Telugu"],
  ["ml", "Malayalam"], ["mr", "Marathi"], ["gu", "Gujarati"], ["kn", "Kannada"],
  ["pa", "Punjabi"], ["id", "Indonesian"], ["vi", "Vietnamese"], ["th", "Thai"],
  ["tr", "Turkish"], ["nl", "Dutch"], ["pl", "Polish"], ["uk", "Ukrainian"],
  ["fa", "Persian"], ["ms", "Malay"], ["fil", "Filipino"]
];

// Target languages (Google Translate codes)
const TGT_LANGS = [
  ["hi", "Hindi"], ["en", "English"], ["bn", "Bengali"], ["ta", "Tamil"],
  ["te", "Telugu"], ["ml", "Malayalam"], ["mr", "Marathi"], ["gu", "Gujarati"],
  ["kn", "Kannada"], ["pa", "Punjabi"], ["ur", "Urdu"], ["ne", "Nepali"],
  ["si", "Sinhala"], ["es", "Spanish"], ["fr", "French"], ["de", "German"],
  ["it", "Italian"], ["pt", "Portuguese"], ["ru", "Russian"], ["ja", "Japanese"],
  ["ko", "Korean"], ["zh-CN", "Chinese (Simplified)"], ["zh-TW", "Chinese (Traditional)"],
  ["ar", "Arabic"], ["id", "Indonesian"], ["vi", "Vietnamese"], ["th", "Thai"],
  ["tr", "Turkish"], ["nl", "Dutch"], ["pl", "Polish"], ["uk", "Ukrainian"],
  ["fa", "Persian"], ["ms", "Malay"], ["fil", "Filipino"], ["sw", "Swahili"]
];

const LANG_NAMES = Object.fromEntries([...SRC_LANGS, ...TGT_LANGS].map(([c, n]) => [c, n.replace("🔍 ", "")]));

/* ---------------- DOM helpers ---------------- */

const $ = (id) => document.getElementById(id);
const els = {
  apiKey: $("apiKey"), toggleKey: $("toggleKey"),
  dropAudio: $("dropAudio"), audioFile: $("audioFile"), audioChip: $("audioChip"),
  dropSrt: $("dropSrt"), srtFile: $("srtFile"), srtChip: $("srtChip"),
  srcLang: $("srcLang"), tgtLang: $("tgtLang"), engine: $("engine"), whisperModel: $("whisperModel"),
  runBtn: $("runBtn"), progressWrap: $("progressWrap"), bar: $("bar"), status: $("status"), log: $("log"),
  resultCard: $("resultCard"), resultTable: $("resultTable"), detectedBadge: $("detectedBadge"),
  matchBadge: $("matchBadge"), dlTranslated: $("dlTranslated"), dlRetimed: $("dlRetimed"),
  dlTranscript: $("dlTranscript"), ghLink: $("ghLink"), thTrans: $("thTrans")
};

const state = {
  audio: null,       // File
  srtText: null,     // string
  srtName: null,
  segments: null,    // [{index, start, end, text, newStart, newEnd, matched, translated}]
  whisper: null      // {language, text, words}
};

/* ---------------- UI setup ---------------- */

function fillSelect(sel, list, saved) {
  sel.innerHTML = "";
  for (const [code, name] of list) {
    const o = document.createElement("option");
    o.value = code; o.textContent = name;
    sel.appendChild(o);
  }
  if (saved && list.some(([c]) => c === saved)) sel.value = saved;
}

fillSelect(els.srcLang, SRC_LANGS, localStorage.getItem("ss_src") || "auto");
fillSelect(els.tgtLang, TGT_LANGS, localStorage.getItem("ss_tgt") || "hi");
els.engine.value = localStorage.getItem("ss_engine") || "google";
els.whisperModel.value = localStorage.getItem("ss_model") || "whisper-large-v3";
els.apiKey.value = localStorage.getItem("ss_groq_key") || "";
if (REPO_URL.length > 20) els.ghLink.href = REPO_URL; else els.ghLink.style.display = "none";

els.srcLang.onchange = () => localStorage.setItem("ss_src", els.srcLang.value);
els.tgtLang.onchange = () => localStorage.setItem("ss_tgt", els.tgtLang.value);
els.engine.onchange = () => localStorage.setItem("ss_engine", els.engine.value);
els.whisperModel.onchange = () => localStorage.setItem("ss_model", els.whisperModel.value);
els.apiKey.oninput = () => { localStorage.setItem("ss_groq_key", els.apiKey.value.trim()); updateRunState(); };
els.toggleKey.onclick = () => {
  els.apiKey.type = els.apiKey.type === "password" ? "text" : "password";
};

function wireDrop(zone, input, chip, onFile) {
  zone.addEventListener("click", () => input.click());
  input.addEventListener("change", () => input.files[0] && onFile(input.files[0]));
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault(); zone.classList.remove("over");
    if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
  });
}

wireDrop(els.dropAudio, els.audioFile, els.audioChip, (f) => {
  state.audio = f;
  els.audioChip.hidden = false;
  els.audioChip.textContent = `${f.name} (${fmtBytes(f.size)})`;
  els.dropAudio.classList.add("filled");
  updateRunState();
});

wireDrop(els.dropSrt, els.srtFile, els.srtChip, async (f) => {
  const text = await f.text();
  try {
    const segs = parseSubtitle(text);
    if (!segs.length) throw new Error("no cues found");
    state.srtText = text;
    state.srtName = f.name;
    els.srtChip.hidden = false;
    els.srtChip.textContent = `${f.name} — ${segs.length} segments`;
    els.dropSrt.classList.add("filled");
  } catch (err) {
    alert("Could not parse subtitle file: " + err.message);
    state.srtText = null;
  }
  updateRunState();
});

function updateRunState() {
  els.runBtn.disabled = !(state.audio && state.srtText && els.apiKey.value.trim().startsWith("gsk_"));
}

function fmtBytes(n) {
  if (n > 1048576) return (n / 1048576).toFixed(1) + " MB";
  if (n > 1024) return (n / 1024).toFixed(0) + " KB";
  return n + " B";
}

/* ---------------- Subtitle parsing / writing ---------------- */

function parseTime(t) {
  // 00:00:00,000  or  00:00:00.000  or  00:00.000 (VTT short)
  const m = t.trim().match(/^(?:(\d+):)?(\d+):(\d+)[.,](\d{1,3})$/);
  if (!m) throw new Error("bad timestamp: " + t);
  const h = parseInt(m[1] || "0", 10), mi = parseInt(m[2], 10), s = parseInt(m[3], 10);
  const ms = parseInt(m[4].padEnd(3, "0"), 10);
  return h * 3600 + mi * 60 + s + ms / 1000;
}

function parseSubtitle(raw) {
  let text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const isVtt = /^WEBVTT/.test(text.trim());
  if (isVtt) text = text.replace(/^WEBVTT[^\n]*\n/, "");
  const blocks = text.split(/\n\s*\n/);
  const segs = [];
  for (const block of blocks) {
    const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    let i = 0;
    // optional numeric index line (SRT) or cue id (VTT)
    if (i < lines.length && !lines[i].includes("-->")) i++;
    if (i >= lines.length || !lines[i].includes("-->")) continue;
    const [a, b] = lines[i].split("-->");
    const start = parseTime(a);
    const end = parseTime(b.trim().split(/\s+/)[0]); // strip VTT cue settings
    const body = lines.slice(i + 1).join("\n")
      .replace(/<[^>]+>/g, "")      // strip tags
      .replace(/\{\\[^}]*\}/g, ""); // strip ASS-style tags
    if (!body.trim()) continue;
    segs.push({ index: segs.length + 1, start, end, text: body.trim() });
  }
  return segs;
}

function toSrtTime(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

function buildSrt(segments, field) {
  return segments.map((seg, i) =>
    `${i + 1}\n${toSrtTime(seg.newStart)} --> ${toSrtTime(seg.newEnd)}\n${(seg[field] || seg.text).trim()}\n`
  ).join("\n");
}

/* ---------------- Logging / progress ---------------- */

function log(msg, cls = "") {
  els.log.hidden = false;
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

function setProgress(pct, msg) {
  els.progressWrap.hidden = false;
  els.bar.style.width = Math.min(100, pct).toFixed(1) + "%";
  if (msg) els.status.textContent = msg;
}

/* ---------------- Audio preparation (chunking for >24 MB) ---------------- */

const MAX_UPLOAD = 24 * 1024 * 1024;
const CHUNK_SECONDS = 560; // ~9.3 min per chunk at 16 kHz mono s16 ≈ 17.9 MB

async function prepareAudioParts(file) {
  if (file.size <= MAX_UPLOAD) return [{ blob: file, name: file.name, offset: 0 }];

  log(`Audio is ${fmtBytes(file.size)} — decoding & splitting into ≤${Math.round(CHUNK_SECONDS / 60)} min chunks…`);
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const buf = await ctx.decodeAudioData(await file.arrayBuffer());
  ctx.close();

  // Resample to 16 kHz mono
  const rate = 16000;
  const off = new OfflineAudioContext(1, Math.ceil(buf.duration * rate), rate);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const mono = (await off.startRendering()).getChannelData(0);

  const parts = [];
  const chunkLen = CHUNK_SECONDS * rate;
  let pos = 0, idx = 0;
  while (pos < mono.length) {
    let end = Math.min(pos + chunkLen, mono.length);
    if (end < mono.length) end = findQuietCut(mono, end, rate);
    const wav = encodeWav(mono.subarray(pos, end), rate);
    parts.push({ blob: wav, name: `chunk${idx}.wav`, offset: pos / rate });
    pos = end; idx++;
  }
  log(`Split into ${parts.length} chunks.`);
  return parts;
}

// look ±3 s around target for the quietest 200 ms window, cut there
function findQuietCut(data, target, rate) {
  const half = 3 * rate, win = Math.floor(0.2 * rate);
  const lo = Math.max(0, target - half), hi = Math.min(data.length - win, target + half);
  let best = target, bestE = Infinity;
  for (let i = lo; i < hi; i += Math.floor(win / 2)) {
    let e = 0;
    for (let j = i; j < i + win; j += 8) e += data[j] * data[j];
    if (e < bestE) { bestE = e; best = i + Math.floor(win / 2); }
  }
  return best;
}

function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); ws(8, "WAVE");
  ws(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); ws(36, "data"); v.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

/* ---------------- Groq Whisper transcription ---------------- */

async function transcribe(apiKey, parts, model, language, onProgress) {
  const allWords = [];
  let fullText = "", detected = null, prevTail = "";

  for (let i = 0; i < parts.length; i++) {
    onProgress(i, parts.length);
    const fd = new FormData();
    fd.append("file", parts[i].blob, parts[i].name);
    fd.append("model", model);
    fd.append("response_format", "verbose_json");
    fd.append("timestamp_granularities[]", "word");
    fd.append("timestamp_granularities[]", "segment");
    fd.append("temperature", "0");
    if (language && language !== "auto") fd.append("language", language);
    if (prevTail) fd.append("prompt", prevTail);

    const res = await fetchRetry("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd
    });
    const data = await res.json();

    if (!detected && data.language) detected = data.language;
    fullText += (fullText ? " " : "") + (data.text || "").trim();
    const off = parts[i].offset;
    for (const w of (data.words || [])) {
      allWords.push({ word: w.word, start: w.start + off, end: w.end + off });
    }
    prevTail = (data.text || "").trim().split(/\s+/).slice(-30).join(" ");
  }
  onProgress(parts.length, parts.length);
  return { language: detected, text: fullText, words: allWords };
}

async function fetchRetry(url, opts, tries = 4) {
  for (let a = 0; ; a++) {
    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      if (a >= tries - 1) throw new Error("Network error: " + e.message);
      await sleep(1500 * (a + 1)); continue;
    }
    if (res.ok) return res;
    const body = await res.text().catch(() => "");
    if (res.status === 429 && a < tries - 1) {
      const wait = parseFloat(res.headers.get("retry-after")) || 6 * (a + 1);
      log(`Rate limited — waiting ${wait.toFixed(0)}s…`);
      await sleep(wait * 1000); continue;
    }
    if (res.status >= 500 && a < tries - 1) { await sleep(2000 * (a + 1)); continue; }
    let msg = body;
    try { msg = JSON.parse(body).error?.message || body; } catch {}
    throw new Error(`API ${res.status}: ${msg.slice(0, 300)}`);
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------------- Alignment: SRT segments ↔ Whisper words ---------------- */

function normWord(w) {
  return w.toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function alignSegments(segments, whisperWords) {
  const wWords = whisperWords
    .map(w => ({ ...w, norm: normWord(w.word) }))
    .filter(w => w.norm);

  // flat list of srt words tagged with their segment index
  const sWords = [];
  segments.forEach((seg, si) => {
    for (const raw of seg.text.split(/\s+/)) {
      const n = normWord(raw);
      if (n) sWords.push({ norm: n, si });
    }
  });

  // greedy sequential matching with a lookahead window
  const WINDOW = 18;
  const segMatches = segments.map(() => []);
  let wi = 0;
  for (const sw of sWords) {
    for (let j = wi; j < Math.min(wi + WINDOW, wWords.length); j++) {
      if (wWords[j].norm === sw.norm) {
        segMatches[sw.si].push(wWords[j]);
        wi = j + 1;
        break;
      }
    }
  }

  const segWordCount = segments.map((seg) =>
    seg.text.split(/\s+/).map(normWord).filter(Boolean).length || 1);

  let matchedCount = 0, totalWords = 0, totalMatched = 0;
  segments.forEach((seg, i) => {
    const m = segMatches[i];
    const need = segWordCount[i] <= 3 ? 1 : Math.max(2, Math.ceil(segWordCount[i] * 0.3));
    totalWords += segWordCount[i];
    totalMatched += m.length;
    if (m.length >= need) {
      seg.newStart = m[0].start;
      seg.newEnd = m[m.length - 1].end;
      seg.matched = true;
      matchedCount++;
    } else {
      seg.matched = false;
    }
  });

  interpolateUnmatched(segments);
  enforceMonotonic(segments);

  return {
    matchedSegments: matchedCount,
    totalSegments: segments.length,
    wordMatchRatio: totalWords ? totalMatched / totalWords : 0
  };
}

// place unmatched segments by linearly mapping their original times
// into the gap between the surrounding matched segments
function interpolateUnmatched(segments) {
  const n = segments.length;
  for (let i = 0; i < n; i++) {
    if (segments[i].matched) continue;
    // find run [i..j] of unmatched
    let j = i;
    while (j + 1 < n && !segments[j + 1].matched) j++;
    const prev = i > 0 ? segments[i - 1] : null;
    const next = j + 1 < n ? segments[j + 1] : null;

    if (prev && next) {
      const oldLo = prev.end, oldHi = next.start;
      const newLo = prev.newEnd, newHi = next.newStart;
      const oldSpan = Math.max(oldHi - oldLo, 0.001);
      const scale = Math.max(newHi - newLo, 0) / oldSpan;
      for (let k = i; k <= j; k++) {
        segments[k].newStart = newLo + (segments[k].start - oldLo) * scale;
        segments[k].newEnd = newLo + (segments[k].end - oldLo) * scale;
      }
    } else if (next) {            // run at the very beginning → shift with next
      const d = next.newStart - next.start;
      for (let k = i; k <= j; k++) {
        segments[k].newStart = Math.max(0, segments[k].start + d);
        segments[k].newEnd = Math.max(0, segments[k].end + d);
      }
    } else if (prev) {            // run at the very end → shift with prev
      const d = prev.newEnd - prev.end;
      for (let k = i; k <= j; k++) {
        segments[k].newStart = segments[k].start + d;
        segments[k].newEnd = segments[k].end + d;
      }
    } else {                      // nothing matched at all → keep original times
      for (let k = i; k <= j; k++) {
        segments[k].newStart = segments[k].start;
        segments[k].newEnd = segments[k].end;
      }
    }
    i = j;
  }
}

function enforceMonotonic(segments) {
  const MIN_DUR = 0.30;
  let prevEnd = 0;
  for (const seg of segments) {
    if (!(seg.newStart >= 0)) seg.newStart = prevEnd;
    if (seg.newStart < prevEnd) seg.newStart = prevEnd;
    const origDur = Math.max(seg.end - seg.start, MIN_DUR);
    if (!(seg.newEnd > seg.newStart)) seg.newEnd = seg.newStart + origDur;
    if (seg.newEnd - seg.newStart < MIN_DUR) seg.newEnd = seg.newStart + MIN_DUR;
    prevEnd = seg.newEnd;
  }
}

/* ---------------- Translation engines ---------------- */

async function translateAll(segments, target, engine, apiKey, onProgress) {
  const texts = segments.map(s => s.text.replace(/\s*\n\s*/g, " ").trim());
  const out = new Array(texts.length);
  if (engine === "groq") {
    await translateGroq(texts, target, apiKey, out, onProgress);
  } else {
    await translateGoogle(texts, target, out, onProgress);
  }
  segments.forEach((s, i) => { s.translated = (out[i] || s.text).trim(); });
}

/* --- Google Translate (free endpoint) --- */

async function translateGoogle(texts, target, out, onProgress) {
  // batch lines joined by newline; fall back to per-line on mismatch
  const batches = [];
  let cur = [], curLen = 0;
  for (let i = 0; i < texts.length; i++) {
    cur.push(i); curLen += texts[i].length + 1;
    if (cur.length >= 20 || curLen > 3500) { batches.push(cur); cur = []; curLen = 0; }
  }
  if (cur.length) batches.push(cur);

  for (let b = 0; b < batches.length; b++) {
    onProgress(b, batches.length);
    const idxs = batches[b];
    const joined = idxs.map(i => texts[i]).join("\n");
    let lines = null;
    try {
      const translated = await googleRequest(joined, target);
      const split = translated.split("\n");
      if (split.length === idxs.length) lines = split;
    } catch (e) { /* fall through to per-line */ }

    if (lines) {
      idxs.forEach((i, k) => { out[i] = lines[k]; });
    } else {
      for (const i of idxs) {
        try { out[i] = await googleRequest(texts[i], target); }
        catch (e) { out[i] = texts[i]; log(`Translate failed for line ${i + 1}: ${e.message}`, "err"); }
        await sleep(120);
      }
    }
    await sleep(250);
  }
  onProgress(batches.length, batches.length);
}

async function googleRequest(text, target) {
  const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" +
    encodeURIComponent(target) + "&dt=t";
  const res = await fetchRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: "q=" + encodeURIComponent(text)
  });
  const data = await res.json();
  return (data[0] || []).map(chunk => chunk[0]).join("");
}

/* --- Groq LLM translation --- */

async function translateGroq(texts, target, apiKey, out, onProgress) {
  const langName = LANG_NAMES[target] || target;
  const batches = [];
  for (let i = 0; i < texts.length; i += 15) batches.push(texts.slice(i, i + 15).map((t, k) => [i + k, t]));

  for (let b = 0; b < batches.length; b++) {
    onProgress(b, batches.length);
    const batch = batches[b];
    const numbered = batch.map(([i, t], k) => `${k + 1}. ${t}`).join("\n");
    const sys = `You are a professional subtitle translator. Translate each numbered line into ${langName}. ` +
      `Keep the tone natural and conversational, suitable for subtitles. ` +
      `Return ONLY a JSON object: {"t": ["translation of line 1", "translation of line 2", ...]} ` +
      `with exactly ${batch.length} strings, same order, no numbering inside the strings.`;
    try {
      const res = await fetchRetry("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: sys },
            { role: "user", content: numbered }
          ]
        })
      });
      const data = await res.json();
      const arr = JSON.parse(data.choices[0].message.content).t;
      if (!Array.isArray(arr) || arr.length !== batch.length) throw new Error("count mismatch");
      batch.forEach(([i], k) => { out[i] = String(arr[k]); });
    } catch (e) {
      log(`Groq LLM batch ${b + 1} failed (${e.message}) — falling back to Google for this batch.`, "err");
      for (const [i, t] of batch) {
        try { out[i] = await googleRequest(t, target); } catch { out[i] = t; }
        await sleep(120);
      }
    }
  }
  onProgress(batches.length, batches.length);
}

/* ---------------- Main pipeline ---------------- */

els.runBtn.addEventListener("click", async () => {
  const apiKey = els.apiKey.value.trim();
  els.runBtn.disabled = true;
  els.resultCard.hidden = true;
  els.log.innerHTML = "";
  try {
    const segments = parseSubtitle(state.srtText);
    state.segments = segments;
    log(`Parsed ${segments.length} subtitle segments from ${state.srtName}.`);

    setProgress(3, "Preparing audio…");
    const parts = await prepareAudioParts(state.audio);

    const model = els.whisperModel.value;
    const srcLang = els.srcLang.value;
    log(`Transcribing with ${model} (${srcLang === "auto" ? "auto-detect language" : "language: " + srcLang})…`);
    const whisper = await transcribe(apiKey, parts, model, srcLang,
      (done, total) => setProgress(5 + (done / total) * 45, `Transcribing audio… chunk ${Math.min(done + 1, total)}/${total}`));
    state.whisper = whisper;
    log(`Whisper returned ${whisper.words.length} words. Detected language: ${whisper.language || "?"}.`, "ok");

    if (whisper.language) {
      els.detectedBadge.hidden = false;
      els.detectedBadge.textContent = "🔍 audio: " + whisper.language;
    }

    setProgress(52, "Aligning subtitle segments to audio…");
    const stats = alignSegments(segments, whisper.words);
    log(`Aligned ${stats.matchedSegments}/${stats.totalSegments} segments directly ` +
      `(word match ${(stats.wordMatchRatio * 100).toFixed(0)}%); the rest interpolated.`, "ok");
    els.matchBadge.hidden = false;
    els.matchBadge.textContent = `⏱ ${stats.matchedSegments}/${stats.totalSegments} re-timed from audio`;

    const target = els.tgtLang.value;
    const engine = els.engine.value;
    log(`Translating ${segments.length} segments → ${LANG_NAMES[target] || target} via ${engine === "groq" ? "Groq LLM" : "Google Translate"}…`);
    await translateAll(segments, target, engine, apiKey,
      (done, total) => setProgress(55 + (done / Math.max(total, 1)) * 43, `Translating… batch ${Math.min(done + 1, total)}/${total}`));

    setProgress(100, "Done ✔"); droplyDoneTune();
    log("Done. Review the table, edit any cell, then download.", "ok");
    renderResults(segments, target);
  } catch (err) {
    console.error(err);
    log("ERROR: " + err.message, "err");
    setProgress(0, "Failed — see log");
  } finally {
    els.runBtn.disabled = false;
    updateRunState();
  }
});

/* ---------------- Results UI + downloads ---------------- */

function renderResults(segments, target) {
  els.thTrans.textContent = "Translated (" + (LANG_NAMES[target] || target) + ")";
  const tbody = els.resultTable.querySelector("tbody");
  tbody.innerHTML = "";
  segments.forEach((seg, i) => {
    const tr = document.createElement("tr");

    const tdN = document.createElement("td");
    tdN.className = "num"; tdN.textContent = i + 1;

    const tdT = document.createElement("td");
    tdT.className = "time" + (seg.matched ? "" : " unmatched");
    tdT.innerHTML =
      `<s>${toSrtTime(seg.start)}</s><br><span class="new">${toSrtTime(seg.newStart)} → ${toSrtTime(seg.newEnd)}</span>`;
    if (!seg.matched) tdT.title = "Not matched in audio — timing interpolated";

    const tdO = document.createElement("td");
    tdO.className = "orig"; tdO.textContent = seg.text;

    const tdX = document.createElement("td");
    tdX.className = "trans";
    tdX.contentEditable = "plaintext-only" in document.body ? "plaintext-only" : "true";
    tdX.textContent = seg.translated;
    tdX.addEventListener("input", () => { seg.translated = tdX.textContent; });

    tr.append(tdN, tdT, tdO, tdX);
    tbody.appendChild(tr);
  });
  els.resultCard.hidden = false;
  els.resultCard.scrollIntoView({ behavior: "smooth", block: "start" });
}

function download(name, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function baseName() {
  return (state.srtName || "subtitles").replace(/\.(srt|vtt)$/i, "");
}

els.dlTranslated.addEventListener("click", () => {
  if (!state.segments) return;
  download(`${baseName()}.${els.tgtLang.value}.srt`, buildSrt(state.segments, "translated"));
});

els.dlRetimed.addEventListener("click", () => {
  if (!state.segments) return;
  download(`${baseName()}.retimed.srt`, buildSrt(state.segments, "text"));
});

els.dlTranscript.addEventListener("click", () => {
  if (!state.whisper) return;
  download(`${baseName()}.transcript.txt`, state.whisper.text || "");
});
