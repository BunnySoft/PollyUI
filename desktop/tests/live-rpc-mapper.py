#!/usr/bin/env python3
"""Bounded standard private-daemon identity queries; no application payloads."""
import json
import os
import re
import subprocess
import time

started = time.monotonic()
seen = set()
while time.monotonic() - started < 360:
    command = ["/usr/bin/dbus-send", "--session", "--print-reply", "--reply-timeout=1000",
               "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus"]
    listing = subprocess.run([*command, "org.freedesktop.DBus.ListNames"],
                             text=True, capture_output=True, timeout=2)
    if listing.returncode:
        print(json.dumps({"error": "ListNames", "stderr": listing.stderr, "pid": os.getpid()}), flush=True)
        raise RuntimeError("Private daemon identity observer failed")
    names = re.findall(r'string "(:[0-9]+\.[0-9]+)"', listing.stdout)
    for name in names:
        if name in seen:
            continue
        seen.add(name)
        values = {}
        for member, field in (("GetConnectionUnixProcessID", "pid"), ("GetConnectionUnixUser", "uid")):
            result = subprocess.run([*command, "org.freedesktop.DBus." + member, "string:" + name],
                                    text=True, capture_output=True, timeout=2)
            match = re.search(r"uint32 ([0-9]+)", result.stdout)
            if result.returncode or not match:
                values[field + "Error"] = result.stderr or result.stdout
            else:
                values[field] = int(match[1])
        print(json.dumps({"elapsedSeconds": round(time.monotonic() - started, 3),
                          "wallTime": time.time(), "observerPid": os.getpid(), "name": name, **values}), flush=True)
    time.sleep(0.5)
