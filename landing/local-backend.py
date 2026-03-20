#!/usr/bin/env python3
"""
Local fallback signup backend for smalltalk-channel landing page.
Use this ONLY for testing or before CF Worker is deployed.

Saves signups to /workspace/projects/smalltalk-channel/data/signups.txt
Runs on port 8080.

Usage: python3 local-backend.py
"""
import http.server
import json
import os
import mimetypes
from datetime import datetime

SIGNUPS_FILE = os.path.join(os.path.dirname(__file__), '../data/signups.txt')
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.dirname(SIGNUPS_FILE), exist_ok=True)

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # suppress default logging

    def do_GET(self):
        # Serve static files from landing/ directory
        path = self.path.split('?')[0]
        if path == '/' or path == '':
            path = '/index.html'
        filepath = os.path.join(STATIC_DIR, path.lstrip('/'))
        if os.path.isfile(filepath):
            mime, _ = mimetypes.guess_type(filepath)
            with open(filepath, 'rb') as f:
                content = f.read()
            self.send_response(200)
            self.send_header('Content-Type', mime or 'text/plain')
            self.send_header('Content-Length', len(content))
            self.end_headers()
            self.wfile.write(content)
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        if self.path != '/api/signup':
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)

        try:
            data = json.loads(body)
        except Exception:
            self._json({'error': 'Invalid JSON'}, 400)
            return

        email = data.get('email', '').strip().lower()
        honeypot = data.get('honeypot', '')

        # Reject bots silently
        if honeypot:
            self._json({'ok': True}, 200)
            return

        # Validate email
        if not email or '@' not in email or len(email) > 254:
            self._json({'error': 'Invalid email'}, 400)
            return

        # Save
        with open(SIGNUPS_FILE, 'a') as f:
            f.write(f"{datetime.now().isoformat()} | {email} | {self.client_address[0]}\n")

        print(f"[signup] {email}")
        self._json({'ok': True}, 200)

    def _json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    port = 8080
    server = http.server.HTTPServer(('0.0.0.0', port), Handler)
    print(f"Local signup backend running on :{port}")
    print(f"Saving to: {SIGNUPS_FILE}")
    server.serve_forever()
