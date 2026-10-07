#!/usr/bin/env python3
"""One command to a Caret host's debug socket; prints the reply. Exit 1 when the socket does not answer.

  hostq.py <socket> <command...>
"""
import socket
import sys

path, command = sys.argv[1], " ".join(sys.argv[2:])
try:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(5)
        s.connect(path)
        s.sendall((command + "\n").encode())
        s.shutdown(socket.SHUT_WR)
        data = b""
        while chunk := s.recv(65536):
            data += chunk
except OSError as e:
    print(f'{{"error": "socket {path}: {e}"}}')
    sys.exit(1)
sys.stdout.write(data.decode(errors="replace"))
