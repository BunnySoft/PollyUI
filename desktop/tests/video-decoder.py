#!/usr/bin/env python3
"""Exercise the real local decoder's sealed shared frame and one-credit protocol."""
import argparse
import fcntl
import mmap
import os
from pathlib import Path
import select
import signal
import socket
import struct
import sys
import tempfile
import time

MESSAGE = struct.Struct("<IIIIIIIIqqII192s")
MAGIC, VERSION, FRAME, END, ERROR, STATUS, INITIALIZED = 0x50564944, 1, 16, 17, 18, 19, 20
BYTES = 1280 * 720 * 4


def command(channel, operation, flags=0):
    values = [MAGIC, VERSION, operation, flags, 0, 0, 0, 0, 0, 0, 0, 0, bytes(192)]
    channel.sendall(MESSAGE.pack(*values))


class Decoder:
    def __init__(self, executable, source, loop, paused=False):
        self.parent, self.child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self.parent.settimeout(5)
        self.shared = os.memfd_create("polly-video-test", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
        os.ftruncate(self.shared, BYTES)
        fcntl.fcntl(self.shared, fcntl.F_ADD_SEALS, fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL)
        self.pixels = mmap.mmap(self.shared, BYTES, prot=mmap.PROT_READ)
        source_fd = os.open(source, os.O_RDONLY | os.O_CLOEXEC)
        copies = [fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 10) for fd in
                  (source_fd, self.child.fileno(), self.shared)]
        self.pid = os.fork()
        if self.pid == 0:
            try:
                for target, source in enumerate(copies, 3):
                    os.dup2(source, target, inheritable=True)
                if os.geteuid() == 0:
                    os.setgroups([])
                    os.setgid(1000)
                    os.setuid(1000)
                os.execv(executable, [str(executable)])
            except BaseException:
                os._exit(126)
        os.close(source_fd)
        for fd in copies:
            os.close(fd)
        self.child.close()
        command(self.parent, 1, int(loop) | (2 if paused else 0))

    def receive(self):
        packet = self.parent.recv(MESSAGE.size + 1)
        if len(packet) != MESSAGE.size:
            raise RuntimeError("Decoder closed or violated the fixed message bound")
        value = MESSAGE.unpack(packet)
        if value[:2] != (MAGIC, VERSION):
            raise RuntimeError("Decoder ABI mismatch")
        return value

    def frame(self):
        while True:
            value = self.receive()
            if value[2] in (STATUS, INITIALIZED):
                continue
            if value[2] != FRAME:
                raise RuntimeError("Expected video frame, got " + repr(value[2]))
            if value[4:8] != (64, 48, 256, 64 * 48 * 4):
                raise RuntimeError("Fixture dimensions/stride/bytes differ from actual frame")
            if not 0 <= value[8] <= 86400000000 or value[9] != 100000:
                raise RuntimeError("Fixture timestamps/durations are not the actual 10FPS source")
            return value

    def close(self):
        try:
            command(self.parent, 5)
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.parent.close()
        deadline = time.monotonic() + 2
        while self.pid:
            result, status = os.waitpid(self.pid, os.WNOHANG)
            if result:
                self.pid = None
                break
            if time.monotonic() >= deadline:
                os.kill(self.pid, signal.SIGKILL)
                os.waitpid(self.pid, 0)
                self.pid = None
                raise RuntimeError("Decoder did not stop at its controlled protocol boundary")
            time.sleep(0.005)
        self.pixels.close()
        os.close(self.shared)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("decoder", type=Path)
    parser.add_argument("--fixtures", type=Path)
    args = parser.parse_args()
    fixtures = args.fixtures or (Path(os.environ["POLLY_VIDEO_TEST_FILES"]) if os.environ.get("POLLY_VIDEO_TEST_FILES") else None)
    if fixtures is None:
        print("UNQUALIFIED: supply original encoded MP4/WebM test fixtures explicitly")
        return 77
    for suffix in ("mp4", "webm"):
        decoder = Decoder(args.decoder.resolve(strict=True), fixtures / ("colors." + suffix), True, paused=True)
        try:
            while True:
                value = decoder.receive()
                if value[2] == INITIALIZED:
                    break
                if value[2:4] != (STATUS, 1):
                    raise RuntimeError("Paused initialization published frame work before explicit Play")
            if select.select([decoder.parent], [], [], 0.15)[0]:
                raise RuntimeError("Paused initialized source performed recurring frame work")
            command(decoder.parent, 4)
            if decoder.frame()[8] != 0:
                raise RuntimeError("Paused-start timeline did not begin at the first source timestamp")
            print("PASS: " + suffix + " starts paused without publishing a frame before explicit Play")
        finally:
            decoder.close()
        decoder = Decoder(args.decoder.resolve(strict=True), fixtures / ("colors." + suffix), True)
        try:
            first = decoder.frame()
            held = bytes(decoder.pixels[:first[7]])
            command(decoder.parent, 3)
            while True:
                status = decoder.receive()
                if status[2] == STATUS and status[3] == 1:
                    break
                raise RuntimeError("Only one shared frame may be outstanding before pause")
            if select.select([decoder.parent], [], [], 0.2)[0] or bytes(decoder.pixels[:first[7]]) != held:
                raise RuntimeError("Paused decoder performed uncredited frame work")
            command(decoder.parent, 4)
            status = decoder.receive()
            if status[2:4] != (STATUS, 0) or select.select([decoder.parent], [], [], 0.05)[0]:
                raise RuntimeError("Resume must retain frame credit until the native owner releases it")
            colors = set()
            previous = first
            for _ in range(24):
                x, y = 32, 24
                pixel = tuple(decoder.pixels[(y * 64 + x) * 4:(y * 64 + x + 1) * 4])
                if pixel[3] != 255:
                    raise RuntimeError("Decoder emitted non-opaque wallpaper alpha")
                colors.add(max(range(3), key=lambda channel: pixel[channel]))
                command(decoder.parent, 2)
                value = decoder.frame()
                if value[10] < previous[10] or (value[10] == previous[10] and value[8] < previous[8]):
                    raise RuntimeError("Decoder timeline regressed without a loop boundary")
                previous = value
                if value[10] >= 1 and len(colors) == 3:
                    break
            if previous[10] < 1 or len(colors) != 3:
                raise RuntimeError("Actual source colors or loop boundary were not decoded")
            print("PASS: " + suffix + " actual BGRA pixels, loop/timestamps, pause/resume and one-frame credit ownership")
        finally:
            decoder.close()
    for name in ("malformed.mp4", "oversized.mp4"):
        decoder = Decoder(args.decoder.resolve(strict=True), fixtures / name, False)
        try:
            while True:
                value = decoder.receive()
                if value[2] in (STATUS, INITIALIZED):
                    continue
                if value[2] != ERROR or not value[12].split(b"\0", 1)[0]:
                    raise RuntimeError("Invalid source did not report an explicit decoder error: " + name)
                print("PASS: explicit bounded rejection of " + name)
                break
        finally:
            decoder.close()
    decoder = Decoder(args.decoder.resolve(strict=True), fixtures / "colors.mp4", False)
    try:
        frames = 0
        while True:
            value = decoder.receive()
            if value[2] in (STATUS, INITIALIZED):
                continue
            if value[2] == FRAME:
                frames += 1
                command(decoder.parent, 2)
            elif value[2] == END:
                break
            else:
                raise RuntimeError("Non-looping source did not end explicitly")
        if frames != 9:
            raise RuntimeError("Non-looping fixture did not deliver its exact nine frames")
        print("PASS: non-looping source delivers nine actual frames and an explicit end")
    finally:
        decoder.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
