/**
 * Furnace Web Player - Emscripten WASM entry point.
 *
 * A thin extern "C" surface over a single headless DivEngine, exposed to
 * JavaScript. Audio is rendered on demand via the engine's export render path
 * (nextBuf with calledFromExport=true), so no real audio backend is opened:
 * the engine runs with DIV_AUDIO_DUMMY and the browser pulls samples through
 * wp_render().
 *
 * This mirrors the headless setup used by the CLI render mode in src/main.cpp
 * (setAudio(DIV_AUDIO_DUMMY) + load()).
 */

#include "../engine/engine.h"
#include "../ta-log.h"
#include <string.h>
#include <stdio.h>
#include <vector>

// Normally provided by main.cpp on desktop; the engine calls it to surface fatal
// errors. main.cpp isn't part of the web build, so provide a browser version
// that just logs to stderr (Emscripten routes stderr to the JS console).
void reportError(String what) {
  fprintf(stderr, "furnace: %s\n", what.c_str());
}

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define WP_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define WP_EXPORT extern "C"
#endif

static DivEngine* e = NULL;
static String lastError;
// Scratch planar buffers handed to the engine; the engine writes interleaved-
// per-channel float output here and we hand the pointers back through render.
static float* chanBuf[2] = {NULL, NULL};
static int chanBufFrames = 0;

static void ensureChanBuf(int frames) {
  if (frames <= chanBufFrames) return;
  if (chanBuf[0]) delete[] chanBuf[0];
  if (chanBuf[1]) delete[] chanBuf[1];
  chanBuf[0] = new float[frames];
  chanBuf[1] = new float[frames];
  chanBufFrames = frames;
}

/**
 * Initialise the engine at the given output sample rate (should match the
 * browser AudioContext.sampleRate). Returns 1 on success, 0 on failure.
 */
WP_EXPORT int wp_init(int sampleRate) {
  if (e != NULL) return 1;
  // route engine logs to stdout (Emscripten forwards to the JS console) so
  // module-load diagnostics are visible. Unbuffered so nothing is lost if we
  // never reach a clean runtime exit (EXIT_RUNTIME=0).
  setvbuf(stdout, NULL, _IONBF, 0);
  initLog(stdout);
  logLevel = LOGLEVEL_WARN;
  e = new DivEngine();

  // headless: no safe-mode dialog, no window. preInit() returns whether safe
  // mode was requested (normally false) - not an error, so ignore the result.
  e->preInit(true);

  // render at the browser's sample rate so no resampling is needed.
  e->setConf("audioRate", sampleRate);
  // no real device: we pull samples ourselves via nextBuf(calledFromExport).
  e->setAudio(DIV_AUDIO_DUMMY);

  if (!e->init()) {
    lastError = "engine init failed";
    return 0;
  }
  return 1;
}

/**
 * Load a module (.fur/.dmf/.fui/...) from a heap buffer. DivEngine::load takes
 * ownership of the buffer it is given (it frees it internally on every path -
 * see fileOpsCommon.cpp), so we hand it a fresh new[] copy and never free it
 * ourselves. Returns 1 on success, 0 on failure.
 */
WP_EXPORT int wp_load(const unsigned char* buf, int len) {
  if (e == NULL || buf == NULL || len <= 0) {
    lastError = "not initialised or empty buffer";
    return 0;
  }
  e->stop();
  unsigned char* owned = new unsigned char[len];
  memcpy(owned, buf, len);
  // load() adopts `owned` and manages its lifetime, including on failure.
  bool loadOk = false;
  try {
    loadOk = e->load(owned, (size_t)len, NULL);
  } catch (std::exception& ex) {
    lastError = String("exception during load: ") + ex.what();
    return 0;
  } catch (...) {
    lastError = "unknown exception during load";
    return 0;
  }
  if (!loadOk) {
    lastError = e->getLastError();
    return 0;
  }
  return 1;
}

/** Start playback from the beginning. */
WP_EXPORT void wp_play() {
  if (e == NULL) return;
  e->stop();
  e->setOrder(0);
  e->play();
}

/** Stop playback. */
WP_EXPORT void wp_stop() {
  if (e == NULL) return;
  e->stop();
}

/**
 * Render `frames` stereo frames into the JS-owned left/right Float32 heap
 * buffers. Returns the number of frames written.
 */
WP_EXPORT int wp_render(float* left, float* right, int frames) {
  if (e == NULL || left == NULL || right == NULL || frames <= 0) return 0;
  ensureChanBuf(frames);
  float* out[2] = {chanBuf[0], chanBuf[1]};
  memset(chanBuf[0], 0, sizeof(float) * frames);
  memset(chanBuf[1], 0, sizeof(float) * frames);
  // calledFromExport=true: render synchronously without touching the (absent)
  // audio device.
  e->nextBuf(NULL, out, 0, 2, (unsigned int)frames, true);
  memcpy(left, chanBuf[0], sizeof(float) * frames);
  memcpy(right, chanBuf[1], sizeof(float) * frames);
  return frames;
}

/** 1 if currently playing, else 0. */
WP_EXPORT int wp_isPlaying() {
  if (e == NULL) return 0;
  return e->isPlaying() ? 1 : 0;
}

/** Current order (pattern-sequence position). */
WP_EXPORT int wp_getOrder() {
  if (e == NULL) return 0;
  int order = 0, row = 0;
  e->getPlayPos(order, row);
  return order;
}

/** Current row within the pattern. */
WP_EXPORT int wp_getRow() {
  if (e == NULL) return 0;
  int order = 0, row = 0;
  e->getPlayPos(order, row);
  return row;
}

/** Song name (UTF-8), valid until the next call. */
WP_EXPORT const char* wp_getSongName() {
  if (e == NULL) return "";
  return e->song.name.c_str();
}

/** Song author (UTF-8), valid until the next call. */
WP_EXPORT const char* wp_getSongAuthor() {
  if (e == NULL) return "";
  return e->song.author.c_str();
}

/** Last error message (UTF-8). */
WP_EXPORT const char* wp_getLastError() {
  return lastError.c_str();
}

// ---------------------------------------------------------------------------
// Per-channel visualization (the SPC700-player-style mixer / scope view).
//
// Every chip fills a DivDispatchOscBuffer per channel during rendering: 16-bit
// samples at a fixed 65536 Hz, with a 16.16 fixed-point write cursor (`needle`)
// and a "-1 means hold previous sample" encoding. We read a trailing window of
// that buffer to derive both a VU level and a scope waveform, universally for
// any console.
// ---------------------------------------------------------------------------

/** Number of channels in the loaded module (0 if nothing loaded). */
WP_EXPORT int wp_getChannelCount() {
  if (e == NULL) return 0;
  return e->getTotalChannelCount();
}

/** Short name of a channel (e.g. "S1", "FM3"), UTF-8, valid until next call. */
WP_EXPORT const char* wp_getChannelName(int ch) {
  if (e == NULL || ch < 0 || ch >= e->getTotalChannelCount()) return "";
  const char* n = e->getChannelShortName(ch);
  return n ? n : "";
}

/**
 * Fill `out` with the *instantaneous* VU level in [0,1] for each channel and
 * return the channel count. This is the raw peak-to-peak estimate over a 30 ms
 * window at the current render position (30 ms window, sqrt shaping, like
 * FurnaceGUI::calcChanOsc but without the release decay). The caller captures
 * this per audio block and applies the attack/release smoothing at display time
 * so the meter stays A/V-synced regardless of render cadence.
 */
WP_EXPORT int wp_getChannelLevels(float* out, int maxCh) {
  if (e == NULL) return 0;
  int chans = e->getTotalChannelCount();
  if (chans > maxCh) chans = maxCh;
  const int displaySize = (int)(65536.0f * 0.03f); // 30 ms
  for (int c = 0; c < chans; c++) {
    DivDispatchOscBuffer* buf = e->getOscBuffer(c);
    float estimate = 0.0f;
    if (buf != NULL) {
      short minLevel = 32767, maxLevel = -32768;
      unsigned short needlePos = buf->needle >> 16;
      for (unsigned short i = needlePos - displaySize; i != needlePos; i++) {
        short y = buf->data[i];
        if (y == -1) continue;
        if (minLevel > y) minLevel = y;
        if (maxLevel < y) maxLevel = y;
      }
      estimate = powf((float)(maxLevel - minLevel) / 32768.0f, 0.5f);
      if (estimate > 1.0f) estimate = 1.0f;
    }
    out[c] = estimate;
  }
  return chans;
}

/**
 * Fill `out` with `n` samples in [-1,1] of channel `ch`'s scope (the trailing
 * ~20 ms of its osc buffer), for drawing a per-channel waveform. Returns n, or
 * 0 if unavailable.
 */
WP_EXPORT int wp_getChannelScope(int ch, float* out, int n) {
  if (e == NULL || out == NULL || n <= 0) return 0;
  if (ch < 0 || ch >= e->getTotalChannelCount()) return 0;
  DivDispatchOscBuffer* buf = e->getOscBuffer(ch);
  if (buf == NULL) { memset(out, 0, sizeof(float) * n); return n; }
  const int windowSize = (int)(65536.0f * 0.02f); // 20 ms
  unsigned short start = (buf->needle >> 16) - windowSize;
  short last = 0;
  for (int i = 0; i < n; i++) {
    unsigned short idx = start + (unsigned short)((long)i * windowSize / n);
    short y = buf->data[idx];
    if (y != -1) last = y;
    out[i] = (float)last / 32768.0f;
  }
  return n;
}

// Emscripten expects an entry point; the runtime is kept alive (EXIT_RUNTIME=0)
// so the exported wp_* functions remain callable after main() returns.
int main() {
  return 0;
}
