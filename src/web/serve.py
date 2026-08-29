#!/usr/bin/env python3
"""Tiny static server for the Furnace web player.

Serves the web/ directory (index.html, player.js) and transparently falls back
to the CMake build output directory for the compiled furnace-web.js, so you
don't have to copy artifacts around.

    python web/serve.py                 # serves on http://localhost:8000
    python web/serve.py 9000            # custom port
    python web/serve.py 8000 build-web  # custom build dir

Single-threaded WASM: no COOP/COEP headers are required. (If you later switch to
an AudioWorklet + pthreads build, set CROSS_ORIGIN_ISOLATION = True below.)
"""

import http.server
import os
import socketserver
import sys

WEB_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(WEB_DIR)

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
BUILD_DIR = os.path.join(REPO_DIR, sys.argv[2] if len(sys.argv) > 2 else 'build-web')

# WASM builds that use pthreads/SharedArrayBuffer need these; the single-threaded
# player does not, so keep them off to avoid CORP hassles with local files.
CROSS_ORIGIN_ISOLATION = False


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def translate_path(self, path):
        # Serve from web/ first; if the file isn't there, look in the build dir
        # (this is where furnace-web.js lands).
        local = super().translate_path(path)
        if not os.path.exists(local):
            rel = path.lstrip('/').split('?', 1)[0].split('#', 1)[0]
            candidate = os.path.join(BUILD_DIR, rel)
            if os.path.exists(candidate):
                return candidate
        return local

    def end_headers(self):
        if CROSS_ORIGIN_ISOLATION:
            self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
            self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        # always serve the freshest build during development
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # quiet


# correct MIME types (raw, no compression: 5 MB over localhost is instant and
# far more robust than a hand-rolled gzip path)
Handler.extensions_map['.wasm'] = 'application/wasm'
Handler.extensions_map['.js'] = 'text/javascript'
Handler.extensions_map['.mjs'] = 'text/javascript'


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    print(f'Furnace web player: http://localhost:{PORT}')
    print(f'  web dir:   {WEB_DIR}')
    print(f'  build dir: {BUILD_DIR}')
    with Server(('127.0.0.1', PORT), Handler) as httpd:
        httpd.serve_forever()
