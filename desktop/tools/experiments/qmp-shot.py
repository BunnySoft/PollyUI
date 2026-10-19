#!/usr/bin/env python3
"""Take a QEMU screendump over a QMP Unix socket."""
import json
import socket
import sys

if len(sys.argv) != 3:
    raise SystemExit("usage: qmp-shot.py QMP_SOCKET OUTPUT.ppm")

sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(sys.argv[1])
sock.settimeout(5)
print(sock.recv(4096).decode(errors="replace"))


def command(obj):
    sock.sendall((json.dumps(obj) + "\n").encode())
    data = b""
    while b"\n" not in data:
        data += sock.recv(4096)
    print(data.decode(errors="replace"))


command({"execute": "qmp_capabilities"})
command({"execute": "screendump", "arguments": {"filename": sys.argv[2]}})
