#!/usr/bin/env python3
"""Check production Shell argument matching and colored logger JSON parsing."""
import importlib.util
import json
from pathlib import Path
import re
import sys
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("guest", Path(__file__).with_name("live-newarch-guest.py"))
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)
boot_spec = importlib.util.spec_from_file_location("boot", Path(__file__).with_name("live-boot.py"))
boot = importlib.util.module_from_spec(boot_spec)
boot_spec.loader.exec_module(boot)


class Protocol(unittest.TestCase):
    def test_diagnostic_never_weakens_acceptance_input_gates(self):
        self.assertTrue(boot.acceptance_input_required(False, False))
        self.assertTrue(boot.acceptance_input_required(False, True))
        self.assertTrue(boot.acceptance_input_required(True, False))
        self.assertFalse(boot.acceptance_input_required(True, True))
        source = Path(__file__).with_name("live-boot.py").read_text()
        self.assertIn('"acceptance": False', source)
        self.assertIn('"skippedAcceptanceGates"', source)
        self.assertIn('Completed startup diagnosis only; no acceptance result was published', source)

    def test_actual_production_arguments(self):
        args = ["/usr/bin/pollyui", "--desktop", "--no-legacy-storage", "--app-id", "org.pollyui.shell",
                "/usr/share/pollyui/desktop/shell/live.mjs"]
        self.assertTrue(guest.live_shell(args))
        self.assertFalse(guest.live_shell([value.replace("--desktop", "--desktop-shell") for value in args]))
        self.assertFalse(guest.live_shell([value.replace("org.pollyui.shell", "org.pollyui.settings") for value in args]))
        source = Path(__file__).resolve().parents[1] / "tools/run-session.sh"
        self.assertIn('--shell "$ui" --desktop ', source.read_text())

    def test_real_logger_marker_not_command_echo(self):
        marker = r"polly-vm-check\[\d+\]: POLLY_VM_CONSOLE_READY"
        self.assertIsNone(re.search(marker, "logger -t polly-vm-check POLLY_VM_CONSOLE_READY"))
        transcript = "[77.49] polly-vm-check[860]: \x1b[0;1;39mPOLLY_VM_CONSOLE_READY\x1b[0m"
        self.assertIsNotNone(re.search(marker, re.sub(r"\x1b\[[0-9;]*m", "", transcript)))
        response = 'POLLY_VM_NEWARCH_PREPARE={"shellPid":602,"filesNative":true}\x1b[0m'
        cleaned = re.sub(r"\x1b\[[0-9;]*m", "", response)
        self.assertTrue(json.loads(cleaned.split("=", 1)[1])["filesNative"])


if __name__ == "__main__":
    unittest.main()
