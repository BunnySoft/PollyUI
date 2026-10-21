#!/usr/bin/env python3
"""Verify Standard/full display, network, audio and command payloads, not hardware operation."""
import argparse
import fnmatch
import json
import os
from pathlib import Path
import runpy
import subprocess

HERE = Path(__file__).resolve().parent
COMMANDS = (
    "bash", "sh", "ls", "cp", "mv", "mkdir", "rm", "chmod", "chown", "find", "grep", "sed", "awk",
    "ps", "top", "free", "pgrep", "pkill", "less", "nano", "vi", "tar", "gzip", "bzip2", "xz",
    "unzip", "zip", "curl", "wget", "ssh", "scp", "sftp", "rsync", "lsof", "ping", "tracepath",
    "traceroute", "dig", "nslookup", "file", "git", "ip", "ss", "ethtool", "lspci", "lsusb",
    "python3", "apt", "apt-get", "dpkg", "journalctl", "systemctl", "dmesg", "mount", "lsblk", "blkid",
    "iw", "iwctl", "rfkill", "aplay", "arecord", "amixer", "alsactl",
)
GP107_FIRMWARE = ("fecs_inst.bin", "fecs_data.bin", "fecs_sig.bin", "gpccs_inst.bin",
                 "gpccs_data.bin", "gpccs_sig.bin", "sw_ctx.bin", "sw_nonctx.bin")
WIRELESS_FIRMWARE = (
    "iwlwifi-ty-a0-gf-a0-89.ucode", "rtw88/rtw8822c_fw.bin", "rtw89/rtw8852b_fw.bin",
    "ath10k/QCA6174/hw3.0/firmware-6.bin", "ath11k/WCN6855/hw2.0/amss.bin",
    "ath12k/WCN7850/hw2.0/amss.bin", "brcm/brcmfmac43602-pcie.bin",
    "mediatek/WIFI_RAM_CODE_MT7961_1.bin", "mediatek/mt7925/WIFI_RAM_CODE_MT7925_1_1.bin",
)
AUDIO_FIRMWARE = (
    "intel/sof/sof-tgl.ri", "intel/dsp_fw_cnl.bin",
    "cirrus/cs35l41/v6.83.0/halo_cspl_RAM_revB2_29.85.0.wmfw",
)
AUDIO_RESOURCES = (
    "usr/share/alsa/ucm2/ucm.conf", "usr/share/alsa/ucm2/Intel/sof-hda-dsp/sof-hda-dsp.conf",
    "usr/share/alsa/ucm2/USB-Audio/USB-Audio.conf",
    "usr/share/alsa/topology/hda-dsp/skl_hda_dsp_generic-tplg.conf",
    "usr/lib/x86_64-linux-gnu/spa-0.2/alsa/libspa-alsa.so",
    "usr/share/pollyui/desktop/system/pipewire.conf",
)
P1000_MODALIAS = "pci:v000010DEd00001CB1sv000010DEsd000011C1bc03sc00i00"


def output(*args):
    return subprocess.check_output(args, text=True, timeout=30).strip()


def firmware_file(root, relative):
    path = root / "usr/lib/firmware" / relative
    for candidate in (path, Path(str(path) + ".xz"), Path(str(path) + ".zst")):
        if candidate.is_file() and candidate.stat().st_size:
            return str(candidate.relative_to(root))
    raise ValueError("Missing firmware payload: " + relative)


def verify(root=Path("/"), command=output):
    root = root.resolve(strict=True)
    releases = [directory.name for directory in (root / "lib/modules").iterdir() if directory.is_dir()]
    if len(releases) != 1:
        raise ValueError("Expected exactly one target kernel, not the container host kernel")
    release = releases[0]
    kernel_config = (root / ("boot/config-" + release)).read_text()
    if "CONFIG_DRM_NOUVEAU=m\n" not in kernel_config and "CONFIG_DRM_NOUVEAU=y\n" not in kernel_config:
        raise ValueError("Target kernel does not include Nouveau")
    module_paths = {}
    selected = runpy.run_path(str(HERE / "live-profile.py"))["profile"]("full")
    for name in selected["requiredModules"]:
        filename = command("modinfo", "-b", str(root), "-k", release, "-F", "filename", name)
        if not filename:
            raise ValueError("Missing target module: " + name)
        module_paths[name] = filename
    aliases = command("modinfo", "-b", str(root), "-k", release, "-F", "alias", "nouveau").splitlines()
    if not any(fnmatch.fnmatchcase(P1000_MODALIAS, alias) for alias in aliases):
        raise ValueError("Nouveau aliases do not cover the Quadro P1000 display device class")
    firmware = [firmware_file(root, "nvidia/gp107/gr/" + name) for name in GP107_FIRMWARE]
    firmware.extend(firmware_file(root, "rtl_nic/" + name) for name in ("rtl8168g-2.fw", "rtl8125b-2.fw"))
    wireless_firmware = [firmware_file(root, name) for name in WIRELESS_FIRMWARE]
    audio_firmware = [firmware_file(root, name) for name in AUDIO_FIRMWARE]
    for relative in AUDIO_RESOURCES:
        resource = root / relative
        if not resource.is_file() or not resource.stat().st_size:
            raise ValueError("Missing ALSA/PipeWire resource: " + relative)
    mesa = root / "usr/lib/x86_64-linux-gnu/dri/nouveau_dri.so"
    if not mesa.is_file() or not mesa.stat().st_size:
        raise ValueError("Missing Nouveau Mesa driver")
    binaries = {}
    for name in COMMANDS:
        matches = [root / directory / name for directory in ("usr/bin", "usr/sbin", "bin", "sbin")]
        found = next((path for path in matches if path.is_file() and os.access(path, os.X_OK)), None)
        if found is None:
            raise ValueError("Missing executable command: " + name)
        binaries[name] = str(found.relative_to(root))
    dhcp = (root / "etc/dhcpcd.conf").read_text()
    if "allowinterfaces eth* en*" not in dhcp or "domain_name_servers" not in dhcp:
        raise ValueError("Wired DHCP/DNS policy missing")
    enabled = root / "etc/systemd/system/multi-user.target.wants/dhcpcd.service"
    if not enabled.is_symlink():
        raise ValueError("Wired DHCP service is not enabled")
    if not (root / "etc/systemd/system/multi-user.target.wants/iwd.service").is_symlink():
        raise ValueError("Wi-Fi iwd service is not enabled")
    ping_policy = root / "etc/sysctl.d/70-polly-live-network.conf"
    if ping_policy.read_text().strip() != "net.ipv4.ping_group_range = 1000 1000":
        raise ValueError("Ordinary-user ICMP datagram policy missing or too broad")
    if (root / "etc/systemd/system/multi-user.target.wants/ssh.service").exists():
        raise ValueError("This command set must not enable a remote SSH server")
    return {
        "schemaVersion": 1, "kind": "standard-full-hardware-payload", "kernelRelease": release,
        "nvidiaRoute": "nouveau-mesa", "target": "Quadro P1000 / GP107",
        "modules": module_paths, "firmware": firmware, "commands": binaries,
        "wirelessFirmware": wireless_firmware, "audioFirmware": audio_firmware,
        "audioResources": list(AUDIO_RESOURCES),
        "wiredNetworking": "DHCP service enabled; link/address/DNS/connectivity not exercised here",
        "wirelessNetworking": "iwd enabled with multi-vendor firmware; real scan/association/DHCP not tested",
        "audio": "HDA/USB/SOF/ACP/Cirrus modules, firmware and ALSA/PipeWire data; real playback/capture not tested",
        "ordinaryUserPing": "ICMP datagram sockets limited to GID 1000; runtime ping not exercised here",
        "gopDesktop": "not-provided-by-stock-kernel" if "CONFIG_DRM_SIMPLEDRM=" not in kernel_config else "not-tested",
        "qualification": "payload-only; no physical GPU, Ethernet, Wi-Fi or audio runtime qualification",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    profiles = runpy.run_path(str(HERE / "live-profile.py"))
    profiles["verify"](Path("/"), "full")
    report = verify()
    text = json.dumps(report, indent=2) + "\n"
    if args.report:
        args.report.write_text(text)
    print(text, end="")
