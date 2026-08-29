// Furnace Web Player front-end.
//
// Loads the Emscripten module (furnace-web.js), hands loaded module bytes to the
// WASM engine, and renders audio on the main thread using a small look-ahead
// scheduler: we repeatedly call wp_render() to fill an AudioBuffer and queue it
// on the AudioContext clock. Single-threaded, no AudioWorklet, no SharedArrayBuffer.

import FurnaceModule from './furnace-web.js';

const els = {
  drop: document.getElementById('drop'),
  file: document.getElementById('file'),
  title: document.getElementById('title'),
  author: document.getElementById('author'),
  play: document.getElementById('play'),
  stop: document.getElementById('stop'),
  order: document.getElementById('order'),
  row: document.getElementById('row'),
  status: document.getElementById('status'),
};

function setStatus(msg, kind) {
  els.status.textContent = msg;
  els.status.className = 'status' + (kind ? ' ' + kind : '');
}

// ---- engine handle ----
let Mod = null;        // Emscripten module instance
let wp = {};           // cwrapped functions
let ctx = null;        // AudioContext
let inited = false;    // wp_init called
let loaded = false;    // a module is loaded

// scheduler state
const BLOCK = 1024;             // frames rendered per call (~21ms @48k: viz sync granularity)
const LOOKAHEAD = 0.2;           // seconds of audio to keep queued ahead
let leftPtr = 0, rightPtr = 0;   // WASM heap scratch buffers
let nextTime = 0;                // AudioContext time of next queued block
let schedTimer = null;
let playing = false;

// ---- visualizer state (SPC700-style per-channel mixer + scope) ----
//
// A/V sync: audio is rendered up to LOOKAHEAD seconds ahead of the speaker, so
// reading the engine's osc buffers "live" would run ahead of the sound. Instead
// we snapshot per-channel levels + scopes at render time, tag each with the
// audio time of the block it came from, and the draw loop shows the snapshot
// that matches the AudioContext playback clock. Sync error is one block (~21ms).
const SCOPE_N = 96;             // samples per channel scope
const VU_RELEASE = 0.86;        // per-frame VU release (fast attack, slow fall)
let viz = {
  canvas: document.getElementById('viz'),
  cctx: null,
  chans: 0,
  names: [],
  levelsPtr: 0,                 // Float32[chans] in WASM heap
  scopePtr: 0,                  // Float32[SCOPE_N] in WASM heap
  raf: 0,
  queue: [],                    // [{t, levels:Float32Array, scopes:Float32Array}]
  disp: null,                   // Float32Array[chans]: smoothed display levels
  lastSnap: null,               // most recent snapshot shown (held between blocks)
};

// (re)configure the visualizer for the currently loaded module's channels.
function setupViz() {
  if (!viz.canvas) return;
  viz.cctx = viz.canvas.getContext('2d');
  viz.chans = wp.chanCount();
  viz.names = [];
  for (let i = 0; i < viz.chans; i++) viz.names.push(wp.chanName(i) || String(i + 1));
  // (re)allocate heap scratch sized to the channel count
  if (viz.levelsPtr) Mod._free(viz.levelsPtr);
  if (viz.scopePtr) Mod._free(viz.scopePtr);
  viz.levelsPtr = Mod._malloc(Math.max(1, viz.chans) * 4);
  viz.scopePtr = Mod._malloc(SCOPE_N * 4);
  viz.queue = [];
  viz.lastSnap = null;
  viz.disp = new Float32Array(viz.chans);
  resizeViz();
  if (!viz.raf) viz.raf = requestAnimationFrame(drawViz);
}

// Capture the current per-channel levels + scopes into a snapshot tagged with
// the audio time `t` it represents. Called right after each block is rendered.
function captureViz(t) {
  if (!viz.chans) return;
  const nch = viz.chans;
  wp.chanLevels(viz.levelsPtr, nch);
  const levels = new Float32Array(Mod.HEAPF32.subarray(viz.levelsPtr >> 2, (viz.levelsPtr >> 2) + nch));
  const scopes = new Float32Array(nch * SCOPE_N);
  for (let i = 0; i < nch; i++) {
    wp.chanScope(i, viz.scopePtr, SCOPE_N);
    scopes.set(Mod.HEAPF32.subarray(viz.scopePtr >> 2, (viz.scopePtr >> 2) + SCOPE_N), i * SCOPE_N);
  }
  viz.queue.push({ t, levels, scopes });
  if (viz.queue.length > 256) viz.queue.shift(); // safety cap
}

// size the canvas backing store to its CSS box * devicePixelRatio (crisp on HiDPI)
function resizeViz() {
  if (!viz.canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = viz.canvas.clientWidth, h = viz.canvas.clientHeight;
  viz.canvas.width = Math.max(1, Math.round(w * dpr));
  viz.canvas.height = Math.max(1, Math.round(h * dpr));
}

// green -> accent orange -> red ramp for a VU level in [0,1]
function levelColor(v) {
  if (v < 0.5) return `rgb(${Math.round(90 + v * 2 * 130)},${Math.round(200 + v * 2 * 20)},120)`;
  const t = (v - 0.5) * 2;
  return `rgb(255,${Math.round(190 - t * 150)},${Math.round(70 - t * 60)})`;
}

function drawViz() {
  viz.raf = requestAnimationFrame(drawViz);
  const c = viz.cctx;
  if (!c || !viz.chans) return;
  const W = viz.canvas.width, H = viz.canvas.height;
  const dpr = window.devicePixelRatio || 1;

  c.clearRect(0, 0, W, H);

  // pick the newest snapshot whose audio time has already reached the speaker
  // (ctx.currentTime), discarding the ones now in the past.
  if (ctx) {
    const now = ctx.currentTime;
    // advance to the latest snapshot the speaker has reached; hold it between
    // blocks so scopes don't flicker when rAF (60fps) outpaces block production.
    while (viz.queue.length && viz.queue[0].t <= now) viz.lastSnap = viz.queue.shift();
  }
  const snap = viz.lastSnap;
  // raw instantaneous levels for this moment (0 if nothing playing yet)
  const raw = snap ? snap.levels : null;
  const scopeData = snap ? snap.scopes : null;

  // JS-side attack/release smoothing, at frame rate, on the audio-aligned level
  const lv = viz.disp;
  for (let i = 0; i < viz.chans; i++) {
    const target = raw ? raw[i] : 0;
    lv[i] = target > lv[i] ? target : lv[i] * VU_RELEASE;
    if (lv[i] < 0.00001) lv[i] = 0;
  }

  const colW = W / viz.chans;
  const pad = Math.max(1, colW * 0.12);
  const scopeH = H * 0.5;          // top half: waveform
  const barTop = H * 0.56;
  const barBot = H - 15 * dpr;     // leave room for labels
  const barMaxH = barBot - barTop;

  c.textAlign = 'center';
  c.textBaseline = 'bottom';
  c.font = `${Math.round(9 * dpr)}px ui-monospace, monospace`;

  for (let i = 0; i < viz.chans; i++) {
    const x = i * colW;
    const cx = x + colW / 2;
    const v = lv[i] || 0;

    // --- per-channel scope waveform (top), from the audio-aligned snapshot ---
    c.strokeStyle = v > 0.001 ? levelColor(v) : 'rgba(154,151,173,0.35)';
    c.lineWidth = Math.max(1, 1.2 * dpr);
    c.beginPath();
    const sMid = scopeH * 0.5;
    const sAmp = scopeH * 0.44;
    const base = i * SCOPE_N;
    for (let s = 0; s < SCOPE_N; s++) {
      const sx = x + pad + (colW - 2 * pad) * (s / (SCOPE_N - 1));
      const sy = sMid - (scopeData ? scopeData[base + s] : 0) * sAmp;
      if (s === 0) c.moveTo(sx, sy); else c.lineTo(sx, sy);
    }
    c.stroke();

    // --- VU bar (bottom) ---
    // track
    c.fillStyle = 'rgba(255,255,255,0.05)';
    c.fillRect(x + pad, barTop, colW - 2 * pad, barMaxH);
    // level
    const bh = barMaxH * v;
    c.fillStyle = levelColor(v);
    c.fillRect(x + pad, barBot - bh, colW - 2 * pad, bh);

    // --- channel label ---
    c.fillStyle = 'rgba(232,230,240,0.75)';
    c.fillText(viz.names[i], cx, H - 3 * dpr);
  }
}

function teardownViz() {
  if (viz.raf) { cancelAnimationFrame(viz.raf); viz.raf = 0; }
  if (viz.cctx) viz.cctx.clearRect(0, 0, viz.canvas.width, viz.canvas.height);
}

window.addEventListener('resize', resizeViz);

async function boot() {
  Mod = await FurnaceModule();
  wp = {
    init:       Mod.cwrap('wp_init', 'number', ['number']),
    load:       Mod.cwrap('wp_load', 'number', ['number', 'number']),
    play:       Mod.cwrap('wp_play', null, []),
    stop:       Mod.cwrap('wp_stop', null, []),
    render:     Mod.cwrap('wp_render', 'number', ['number', 'number', 'number']),
    isPlaying:  Mod.cwrap('wp_isPlaying', 'number', []),
    getOrder:   Mod.cwrap('wp_getOrder', 'number', []),
    getRow:     Mod.cwrap('wp_getRow', 'number', []),
    songName:   Mod.cwrap('wp_getSongName', 'string', []),
    songAuthor: Mod.cwrap('wp_getSongAuthor', 'string', []),
    lastError:  Mod.cwrap('wp_getLastError', 'string', []),
    chanCount:  Mod.cwrap('wp_getChannelCount', 'number', []),
    chanName:   Mod.cwrap('wp_getChannelName', 'string', ['number']),
    chanLevels: Mod.cwrap('wp_getChannelLevels', 'number', ['number', 'number']),
    chanScope:  Mod.cwrap('wp_getChannelScope', 'number', ['number', 'number', 'number']),
  };
  setStatus('Engine ready. Load a module to begin.', 'ok');
}

// Create the AudioContext lazily on first user gesture, then init the engine at
// the context's real sample rate so no resampling is needed.
function ensureAudio() {
  if (ctx) return true;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  const ok = wp.init(ctx.sampleRate);
  if (!ok) {
    setStatus('Engine init failed: ' + wp.lastError(), 'err');
    return false;
  }
  inited = true;
  // one reusable scratch buffer per channel
  leftPtr = Mod._malloc(BLOCK * 4);
  rightPtr = Mod._malloc(BLOCK * 4);
  return true;
}

async function loadFile(file) {
  if (!Mod) { setStatus('Engine still loading&hellip;'); return; }
  if (!ensureAudio()) return;
  stopPlayback();

  setStatus('Loading ' + file.name + '&hellip;');
  const buf = new Uint8Array(await file.arrayBuffer());
  const ptr = Mod._malloc(buf.length);
  Mod.HEAPU8.set(buf, ptr);
  const ok = wp.load(ptr, buf.length);
  Mod._free(ptr);

  if (!ok) {
    loaded = false;
    els.title.textContent = '—';
    els.author.textContent = '';
    els.play.disabled = true;
    setStatus('Could not load module: ' + wp.lastError(), 'err');
    return;
  }

  loaded = true;
  const name = wp.songName() || file.name;
  els.title.textContent = name;
  els.author.textContent = wp.songAuthor() || '';
  els.play.disabled = false;
  setupViz();
  setStatus('Loaded. Press Play.', 'ok');
}

// ---- playback / scheduling ----
function renderBlockTo(audioBuffer) {
  const n = wp.render(leftPtr, rightPtr, BLOCK);
  const L = audioBuffer.getChannelData(0);
  const R = audioBuffer.getChannelData(1);
  // copy out of the WASM heap (subarray is a view; copy so it survives heap growth)
  L.set(Mod.HEAPF32.subarray(leftPtr >> 2, (leftPtr >> 2) + n));
  R.set(Mod.HEAPF32.subarray(rightPtr >> 2, (rightPtr >> 2) + n));
  return n;
}

function schedule() {
  // queue blocks until we're LOOKAHEAD seconds ahead of the playback clock
  while (nextTime < ctx.currentTime + LOOKAHEAD) {
    const ab = ctx.createBuffer(2, BLOCK, ctx.sampleRate);
    renderBlockTo(ab);
    // snapshot the per-channel viz state for this block, tagged with the audio
    // time it will be heard, so the draw loop can play it back in sync.
    captureViz(nextTime);
    const src = ctx.createBufferSource();
    src.buffer = ab;
    src.connect(ctx.destination);
    src.start(nextTime);
    nextTime += BLOCK / ctx.sampleRate;
  }
  els.order.textContent = String(wp.getOrder()).padStart(2, '0');
  els.row.textContent = String(wp.getRow()).padStart(2, '0');
}

function startPlayback() {
  if (!loaded || playing) return;
  if (ctx.state === 'suspended') ctx.resume();
  wp.play();
  playing = true;
  viz.queue = [];               // drop any stale snapshots
  viz.lastSnap = null;
  nextTime = ctx.currentTime + 0.05;
  schedTimer = setInterval(schedule, 50);
  els.play.disabled = true;
  els.stop.disabled = false;
  setStatus('Playing.', 'ok');
}

function stopPlayback() {
  if (schedTimer) { clearInterval(schedTimer); schedTimer = null; }
  if (inited) wp.stop();
  playing = false;
  viz.queue = [];               // let the meters/scopes fall to rest
  viz.lastSnap = null;
  els.play.disabled = !loaded;
  els.stop.disabled = true;
}

// ---- UI wiring ----
els.file.addEventListener('change', (e) => {
  if (e.target.files.length) loadFile(e.target.files[0]);
});
els.drop.addEventListener('dragover', (e) => { e.preventDefault(); els.drop.classList.add('over'); });
els.drop.addEventListener('dragleave', () => els.drop.classList.remove('over'));
els.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  els.drop.classList.remove('over');
  if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
});
els.play.addEventListener('click', startPlayback);
els.stop.addEventListener('click', () => { stopPlayback(); setStatus('Stopped.'); });

boot().catch((err) => setStatus('Failed to load engine: ' + err, 'err'));
