#!/usr/bin/env python3
"""aint — minimal single-user AI chat backend. Python stdlib only."""

import http.server
import json
import os
import pathlib

PORT       = int(os.environ.get('PORT',       '4137'))
DATA_DIR   = pathlib.Path(os.environ.get('DATA_DIR',   '/var/lib/aint'))
STATIC_DIR = pathlib.Path(os.environ.get('STATIC_DIR', '.'))


# ---------------------------------------------------------------------------
# Atomic JSON helpers
# ---------------------------------------------------------------------------

def read_json(path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json_atomic(path, data):
    """Write via a temp file then os.replace() — crash-safe on POSIX."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data))
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# Request handler
# ---------------------------------------------------------------------------

class Handler(http.server.SimpleHTTPRequestHandler):
    """
    /api/chats     GET → return chats.json   |  PUT → replace chats.json
    /api/providers GET → return providers.json | PUT → replace providers.json
    Everything else is served as a static file from STATIC_DIR.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    # ------------------------------------------------------------------ GET
    def do_GET(self):
        if self.path == '/api/chats':
            self._send_json(read_json(DATA_DIR / 'chats.json', []))
        elif self.path == '/api/providers':
            self._send_json(read_json(DATA_DIR / 'providers.json', []))
        else:
            super().do_GET()

    # ------------------------------------------------------------------ PUT
    def do_PUT(self):
        if self.path == '/api/chats':
            self._persist('chats.json')
        elif self.path == '/api/providers':
            self._persist('providers.json')
        else:
            self.send_error(404)

    # ------------------------------------------------------------ helpers
    def _body_json(self):
        length = int(self.headers.get('Content-Length', 0))
        return json.loads(self.rfile.read(length))

    def _send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type',   'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _persist(self, filename):
        try:
            write_json_atomic(DATA_DIR / filename, self._body_json())
            self._send_json({'ok': True})
        except (json.JSONDecodeError, ValueError) as exc:
            self.send_error(400, str(exc))

    def log_message(self, fmt, *args):
        # Plain output — journald adds timestamps when run under systemd.
        print(fmt % args, flush=True)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    addr = ('', PORT)
    server = http.server.HTTPServer(addr, Handler)
    print(f'aint  port={PORT}  static={STATIC_DIR}  data={DATA_DIR}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
