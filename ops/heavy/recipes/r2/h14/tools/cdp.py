"""A small Chrome DevTools Protocol client over --remote-debugging-port, standard library only (the rig's python has no
websocket package). H13 reads page state through it that Caret doesn't own: field values, body.dataset, window.__keys.

The connection sends no Origin header: Chrome refuses websocket clients whose Origin is not allowed
(--remote-allow-origins) and accepts those that send none.
"""
import base64
import hashlib
import json
import os
import socket
import struct
import time
import urllib.parse
import urllib.request


class CDPError(Exception):
    pass


def targets(port, timeout=5):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=timeout) as r:
        return json.loads(r.read())


def page_target(port, url_part):
    """The first page target whose URL contains `url_part`, or None."""
    for t in targets(port):
        if t.get("type") == "page" and url_part in t.get("url", ""):
            return t
    return None


class CDP:
    def __init__(self, ws_url, timeout=10):
        u = urllib.parse.urlparse(ws_url)
        if u.scheme != "ws" or u.hostname not in ("127.0.0.1", "localhost"):
            raise CDPError(f"refusing {ws_url}: only ws:// on this machine")
        self.timeout = timeout
        self.sock = socket.create_connection((u.hostname, u.port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET {u.path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                           f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise CDPError("connection closed during the handshake")
            head += chunk
        head, self.buf = head.split(b"\r\n\r\n", 1)
        lines = head.decode("latin-1").split("\r\n")
        if " 101 " not in lines[0] + " ":
            raise CDPError(f"handshake refused: {lines[0]}")
        want = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        got = next((ln.split(":", 1)[1].strip() for ln in lines[1:] if ln.lower().startswith("sec-websocket-accept:")), "")
        if got != want:
            raise CDPError("handshake: bad Sec-WebSocket-Accept")
        self.next_id = 0

    def close(self):
        try:
            self._frame(0x8, b"")
        except OSError:
            pass
        self.sock.close()

    def _frame(self, opcode, data):
        n = len(data)
        head = bytearray([0x80 | opcode])
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head.append(0x80 | 126)
            head += struct.pack(">H", n)
        else:
            head.append(0x80 | 127)
            head += struct.pack(">Q", n)
        mask = os.urandom(4)
        head += mask
        self.sock.sendall(bytes(head) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise CDPError("connection closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _message(self):
        parts, first = [], None
        while True:
            b0, b1 = self._exact(2)
            op, n = b0 & 0x0F, b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._exact(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._exact(8))[0]
            mask = self._exact(4) if b1 & 0x80 else None
            data = self._exact(n)
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if op == 0x9:
                self._frame(0xA, data)
                continue
            if op == 0xA:
                continue
            if op == 0x8:
                raise CDPError("closed by Chrome")
            if op in (0x1, 0x2):
                first, parts = op, [data]
            elif op == 0x0:
                parts.append(data)
            if b0 & 0x80 and first is not None:
                return b"".join(parts).decode("utf-8")

    def call(self, method, params=None, timeout=None):
        self.next_id += 1
        mid = self.next_id
        self._frame(0x1, json.dumps({"id": mid, "method": method, "params": params or {}}).encode())
        end = time.time() + (timeout or self.timeout)
        while time.time() < end:
            self.sock.settimeout(max(0.1, end - time.time()))
            m = json.loads(self._message())
            if m.get("id") == mid:
                if "error" in m:
                    raise CDPError(f"{method}: {m['error']}")
                return m.get("result", {})
        raise CDPError(f"{method}: no reply in time")

    def eval(self, expression):
        r = self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True})
        if r.get("exceptionDetails"):
            raise CDPError(f"page threw: {r['exceptionDetails'].get('text')}")
        return r.get("result", {}).get("value")
