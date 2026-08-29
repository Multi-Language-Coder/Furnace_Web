// Node harness to exercise the WASM engine without a browser.
//   node web/harness.mjs demos/ay8910/AY-3-8910_Jam.fur
// Prints checkpoints + any ASAN/abort output directly to the console.
import { readFileSync } from 'fs';
import FurnaceModule from '../build-web/furnace-web.js';

const file = process.argv[2] || 'demos/ay8910/AY-3-8910_Jam.fur';

const inst = await FurnaceModule({
  printErr: (t) => console.error('[err] ' + t),
  print: (t) => console.log('[out] ' + t),
});
const c = (n, r, a) => inst.cwrap(n, r, a);

const rate = 48000;
console.log('init =', c('wp_init', 'number', ['number'])(rate));

const bytes = readFileSync(file);
const ptr = inst._malloc(bytes.length);
inst.HEAPU8.set(bytes, ptr);
console.log('loading', file, bytes.length, 'bytes');
const loaded = c('wp_load', 'number', ['number', 'number'])(ptr, bytes.length);
console.log('load =', loaded, 'err =', c('wp_getLastError', 'string', [])());
console.log('song =', c('wp_getSongName', 'string', [])());

if (loaded) {
  c('wp_play', null, [])();
  const N = 2048;
  const L = inst._malloc(N * 4), R = inst._malloc(N * 4);
  let peak = 0, frames = 0;
  for (let b = 0; b < 80; b++) {
    const n = c('wp_render', 'number', ['number', 'number', 'number'])(L, R, N);
    const la = inst.HEAPF32.subarray(L >> 2, (L >> 2) + n);
    for (let i = 0; i < n; i++) { const a = Math.abs(la[i]); if (a > peak) peak = a; }
    frames += n;
  }
  console.log('playing =', c('wp_isPlaying', 'number', [])(),
              'order =', c('wp_getOrder', 'number', [])(),
              'row =', c('wp_getRow', 'number', [])(),
              'frames =', frames, 'peak =', peak.toFixed(4));
}
