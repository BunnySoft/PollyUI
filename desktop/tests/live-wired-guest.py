"""Run only as the public ordinary user inside an isolated user-network QEMU guest."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time


def output(*args):
    return subprocess.check_output(args, text=True, timeout=10).strip()


def main(audio_devices=False):
    if os.getuid() != 1000:
        raise RuntimeError("Wired guest check requires ordinary UID 1000")
    selected = None
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        interfaces = json.loads(output("ip", "-4", "-j", "address", "show", "scope", "global"))
        for interface in interfaces:
            addresses = [item["local"] for item in interface.get("addr_info", []) if item.get("family") == "inet"]
            if "10.0.2.15" in addresses:
                selected = interface
                break
        if selected:
            break
        time.sleep(0.5)
    if not selected:
        raise RuntimeError("Emulated wired interface did not obtain the QEMU DHCP address")
    name = selected["ifname"]
    driver = (Path("/sys/class/net") / name / "device/driver").resolve(strict=True).name
    if driver != "e1000e":
        raise RuntimeError("Wired test did not use its declared Intel Ethernet driver")
    routes = json.loads(output("ip", "-j", "route"))
    if not any(item.get("dst") == "default" and item.get("gateway") == "10.0.2.2" and
               item.get("dev") == name for item in routes):
        raise RuntimeError("Wired DHCP did not install the expected gateway")
    resolver = Path("/etc/resolv.conf").read_text()
    if not re.search(r"^nameserver\s+10\.0\.2\.3\s*$", resolver, re.M):
        raise RuntimeError("DHCP-provided DNS was not published to the system resolver")
    output("ping", "-c", "1", "-W", "3", "10.0.2.2")
    dns = output("dig", "example.com", "A", "+short", "+time=3", "+tries=1")
    if not any(re.fullmatch(r"(?:\d{1,3}\.){3}\d{1,3}", line) for line in dns.splitlines()):
        raise RuntimeError("The system DNS resolver did not resolve the public test name")
    result = {"uid": os.getuid(), "interface": name, "driver": driver, "address": "10.0.2.15",
              "gateway": "10.0.2.2", "dnsServer": "10.0.2.3", "gatewayPing": "pass",
              "dnsQuery": "example.com A", "dns": "pass", "physicalEthernet": "not-tested"}
    if audio_devices:
        for command in ("aplay", "arecord"):
            if not re.search(r"^card \d+: .+device \d+:", output(command, "-l"), re.M):
                raise RuntimeError("Emulated ALSA device was not enumerated by " + command)
        result["emulatedAudio"] = {
            "playbackDevice": "enumerated", "captureDevice": "enumerated",
            "audiblePlayback": "not-tested", "microphoneCapture": "not-tested",
        }
    subprocess.run(["logger", "-t", "polly-wired-check", "POLLY_WIRED_READY=" + json.dumps(result)], check=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio-devices", action="store_true")
    args = parser.parse_args()
    try:
        main(audio_devices=args.audio_devices)
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.SubprocessError) as error:
        subprocess.run(["logger", "-t", "polly-wired-check", "POLLY_WIRED_FAILED=" + str(error)], check=True)
        raise
