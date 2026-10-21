"""Payload verifier fixtures; no installation or physical hardware claims."""
from pathlib import Path
import runpy
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
VERIFY = runpy.run_path(str(REPO / "desktop/release/debian/standard-hardware.py"))


def seed(root):
    (root / "lib/modules/6.12.113+deb13-amd64").mkdir(parents=True)
    (root / "boot").mkdir()
    (root / "boot/config-6.12.113+deb13-amd64").write_text("CONFIG_DRM_NOUVEAU=m\n")
    for name in VERIFY["GP107_FIRMWARE"]:
        path = root / "usr/lib/firmware/nvidia/gp107/gr" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"firmware fixture")
    for name in ("rtl8168g-2.fw", "rtl8125b-2.fw"):
        path = root / "usr/lib/firmware/rtl_nic" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"firmware fixture")
    for name in (*VERIFY["WIRELESS_FIRMWARE"], *VERIFY["AUDIO_FIRMWARE"]):
        path = root / "usr/lib/firmware" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"firmware fixture")
    for name in VERIFY["AUDIO_RESOURCES"]:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"ALSA/PipeWire resource fixture")
    mesa = root / "usr/lib/x86_64-linux-gnu/dri/nouveau_dri.so"
    mesa.parent.mkdir(parents=True)
    mesa.write_bytes(b"driver fixture")
    for name in VERIFY["COMMANDS"]:
        file = root / "usr/bin" / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text("#!/bin/sh\nexit 0\n")
        file.chmod(0o755)
    dhcp = root / "etc/dhcpcd.conf"
    dhcp.parent.mkdir(exist_ok=True)
    dhcp.write_text("allowinterfaces eth* en*\noption domain_name_servers\n")
    enabled = root / "etc/systemd/system/multi-user.target.wants/dhcpcd.service"
    enabled.parent.mkdir(parents=True)
    enabled.symlink_to("/usr/lib/systemd/system/dhcpcd.service")
    (enabled.parent / "iwd.service").symlink_to("/usr/lib/systemd/system/iwd.service")
    ping_policy = root / "etc/sysctl.d/70-polly-live-network.conf"
    ping_policy.parent.mkdir()
    ping_policy.write_text("net.ipv4.ping_group_range = 1000 1000\n")


def command(*args):
    if args[-2] == "alias":
        return "pci:v000010DEd*sv*sd*bc03sc*i*"
    return "/lib/modules/6.12.113+deb13-amd64/" + args[-1] + ".ko.xz"


class StandardPayload(unittest.TestCase):
    def test_payload_proof_is_not_a_hardware_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            seed(root)
            result = VERIFY["verify"](root, command)
            self.assertEqual(result["kernelRelease"], "6.12.113+deb13-amd64")
            self.assertEqual(result["nvidiaRoute"], "nouveau-mesa")
            self.assertEqual(len(result["commands"]), len(VERIFY["COMMANDS"]))
            self.assertIn("payload-only", result["qualification"])
            self.assertEqual(result["gopDesktop"], "not-provided-by-stock-kernel")
            for module in ("iwlwifi", "rtw89_8852be", "ath11k_pci", "brcmfmac", "mt7921e",
                           "snd_usb_audio", "snd_hda_codec_realtek", "snd_sof_pci_intel_tgl", "nvme", "usbhid"):
                self.assertIn(module, result["modules"])
            self.assertIn("not tested", result["wirelessNetworking"])
            self.assertIn("not tested", result["audio"])

    def test_missing_firmware_or_command_fails_explicitly(self):
        for relative in ("usr/lib/firmware/nvidia/gp107/gr/fecs_inst.bin",
                         "usr/lib/firmware/rtl_nic/rtl8125b-2.fw", "usr/bin/ping",
                         "usr/lib/firmware/ath11k/WCN6855/hw2.0/amss.bin",
                         "usr/lib/firmware/mediatek/WIFI_RAM_CODE_MT7961_1.bin",
                         "usr/lib/firmware/intel/dsp_fw_cnl.bin",
                         "usr/share/alsa/ucm2/ucm.conf",
                         "usr/lib/x86_64-linux-gnu/spa-0.2/alsa/libspa-alsa.so"):
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                seed(root)
                (root / relative).unlink()
                with self.assertRaisesRegex(ValueError, "Missing"):
                    VERIFY["verify"](root, command)

    def test_wrong_display_driver_aliases_do_not_qualify_p1000_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            seed(root)
            with self.assertRaisesRegex(ValueError, "aliases"):
                VERIFY["verify"](root, lambda *args: "pci:v00008086d*" if args[-2] == "alias" else command(*args))

    def test_disabled_wired_dhcp_and_enabled_remote_server_are_not_accepted(self):
        for failure in ("dhcp", "ssh"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                seed(root)
                if failure == "dhcp":
                    (root / "etc/dhcpcd.conf").write_text("# absent policy\n")
                else:
                    ssh = root / "etc/systemd/system/multi-user.target.wants/ssh.service"
                    ssh.write_text("remote server fixture\n")
                with self.assertRaisesRegex(ValueError, "DHCP|SSH"):
                    VERIFY["verify"](root, command)

    def test_ping_policy_must_not_grant_all_groups_or_require_root(self):
        for groups in ("0 0", "0 2147483647", "1 0"):
            with self.subTest(groups=groups), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                seed(root)
                (root / "etc/sysctl.d/70-polly-live-network.conf").write_text(
                    "net.ipv4.ping_group_range = " + groups + "\n")
                with self.assertRaisesRegex(ValueError, "ICMP"):
                    VERIFY["verify"](root, command)

    def test_disabled_wifi_service_is_not_an_integrated_wifi_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            seed(root)
            (root / "etc/systemd/system/multi-user.target.wants/iwd.service").unlink()
            with self.assertRaisesRegex(ValueError, "iwd"):
                VERIFY["verify"](root, command)


if __name__ == "__main__":
    unittest.main()
