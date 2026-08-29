# Furnace Web

[Furnace](https://github.com/tildearrow/furnace) — the multi-system chiptune
tracker — compiled to **WebAssembly** and served from a CDN. Two standalone HTML
files, no install, no local server:

| Page | What it is | First load |
| --- | --- | --- |
| [`app.html`](app.html) | The **full tracker**: Dear ImGui UI, ~50 chip emulators, open/save `.fur`, import samples/instruments/wavetables, export VGM. | ~15 MB |
| [`player.html`](player.html) | A lightweight **`.fur`/`.dmf` player** with a per-channel VU + oscilloscope visualizer. | ~4 MB |

`index.html` is a landing page linking both.

## How it works

The Furnace **engine** (`DivEngine`) and, for the full app, the **GUI** are built
with Emscripten into `dist/`:

```
dist/
  furnace.js       furnace.wasm        # full tracker  (WEBGUI build)
  furnace-web.js   furnace-web.wasm     # module player (WEBPLAYER build)
```

The two HTML files are **fully standalone**: each streams its `.js` + `.wasm`
straight from the [jsDelivr](https://www.jsdelivr.com/) GitHub CDN, so you can
open the HTML from anywhere (including `file://`) and it just works.

- **Player** (`player.html`) `import()`s `furnace-web.js` (an ES6 module,
  `EXPORT_NAME=FurnaceModule`) from the CDN and passes
  `locateFile: p => CDN + p` so the runtime fetches `furnace-web.wasm` from the
  CDN too.
- **App** (`app.html`) defines the global `Module` with the same `locateFile`,
  then loads `furnace.js` (classic script) from the CDN.

The CDN base in both files is:

```
https://cdn.jsdelivr.net/gh/Multi-Language-Coder/Furnace_Web@main/dist/
```

`@main` is cached by jsDelivr for ~12 h. For an **immutable, long-cached** URL,
cut a git tag/release and change `@main` to `@<tag>` (one constant near the top
of each HTML file).

## The web port

The engine already had a headless render path (used by audio export), so Phase 1
(the player) reused it; Phase 2 (the full app) moved the SDL2 + ImGui loop onto
`emscripten_set_main_loop` and the WebGL2 backend. Source of the port lives under
[`src/`](src/):

- [`src/wrapper/webPlayer.cpp`](src/wrapper/webPlayer.cpp) — the `extern "C"`
  surface the player front-end drives (`wp_init`, `wp_load`, `wp_render`,
  per-channel level/scope getters, …).
- [`src/web/`](src/web/) — the web front-ends (`player.js`, `index.html`,
  `furnace-shell.html`, `serve.py`) and the local dev harness.
- [`src/furnace-web-port.patch`](src/furnace-web-port.patch) — the diff against
  upstream Furnace: the Emscripten `CMakeLists.txt` branches (`WEBPLAYER` /
  `WEBGUI`), the browser file-dialog shim (`<input>` for open, Blob download for
  save/export), IndexedDB-backed config persistence, and the resilient
  main-loop wrapper (a thrown C++ exception used to kill the browser main loop —
  freezing the display while audio kept playing — so `loopFrame()` is now guarded
  per frame and logs `what()` instead of dying).

### Rebuilding

With the [Emscripten SDK](https://emscripten.org/) active and Furnace's
submodules checked out, apply `src/furnace-web-port.patch` on top of upstream
Furnace, drop `src/wrapper/webPlayer.cpp` in at `src/web/webPlayer.cpp`, then:

```bash
# module player
emcmake cmake -B build-web -DWEBPLAYER=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build-web -j

# full tracker
emcmake cmake -B build-gui -DWEBGUI=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build-gui -j
```

Copy the four resulting artifacts into `dist/` and push.

## License

Furnace is © tildearrow and contributors, licensed **GPL-2.0-or-later**. This
web port and its front-ends inherit that license. See the upstream
[LICENSE](https://github.com/tildearrow/furnace/blob/master/LICENSE).
