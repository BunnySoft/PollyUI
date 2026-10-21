"""Fixtures for the isolated wired guest check; no network or hardware access."""
import json
from pathlib import Path
import runpy
import unittest
from unittest.mock import patch

GUEST = runpy.run_path(str(Path(__file__).with_name("live-wired-guest.py")))


class WiredGuest(unittest.TestCase):
    def run_guest(self, *, driver="e1000e", gateway="10.0.2.2", dns="nameserver 10.0.2.3\n",
                  answer="93.184.215.14\n", uid=1000, audio_devices=False, audio_present=True):
        def output(*args):
            if args[:3] == ("ip", "-4", "-j"):
                return json.dumps([{"ifname": "enp0s4", "addr_info": [
                    {}, {"family": "inet", "local": "10.0.2.15"}]}])
            if args[:3] == ("ip", "-j", "route"):
                return json.dumps([{"dst": "default", "gateway": gateway, "dev": "enp0s4"}])
            if args[0] == "dig":
                return answer
            if args[0] == "ping":
                return "1 received"
            if args[0] in ("aplay", "arecord"):
                return "card 0: Intel [HDA Intel], device 0: Analog [Analog]" if audio_present else ""
            raise AssertionError(args)

        with patch.dict(GUEST["main"].__globals__, output=output), \
                patch("os.getuid", return_value=uid), \
                patch.object(Path, "resolve", return_value=Path("/drivers") / driver), \
                patch.object(Path, "read_text", return_value=dns), \
                patch("subprocess.run") as logged:
            GUEST["main"](audio_devices=audio_devices)
            return json.loads(logged.call_args.args[0][-1].split("=", 1)[1])

    def test_sparse_ip_json_and_real_qualification_boundaries(self):
        result = self.run_guest()
        self.assertEqual(result["driver"], "e1000e")
        self.assertEqual(result["dns"], "pass")
        self.assertEqual(result["physicalEthernet"], "not-tested")

    def test_wrong_user_driver_gateway_dns_or_answer_is_not_a_pass(self):
        for options in ({"uid": 0}, {"driver": "virtio_net"}, {"gateway": "10.0.2.1"},
                        {"dns": "nameserver 127.0.0.1\n"}, {"answer": ""}):
            with self.subTest(options=options), self.assertRaises(RuntimeError):
                self.run_guest(**options)

    def test_optional_audio_enumeration_does_not_claim_audible_playback(self):
        result = self.run_guest(audio_devices=True)
        self.assertEqual(result["emulatedAudio"]["playbackDevice"], "enumerated")
        self.assertEqual(result["emulatedAudio"]["audiblePlayback"], "not-tested")
        self.assertNotIn("emulatedAudio", self.run_guest())
        with self.assertRaisesRegex(RuntimeError, "ALSA"):
            self.run_guest(audio_devices=True, audio_present=False)


if __name__ == "__main__":
    unittest.main()
