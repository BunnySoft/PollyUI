"""Check native generation, determinism, stale detection and explicit failures."""
import argparse
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


GENERATOR = Path(__file__).resolve().parents[1] / "tools" / "generate-files-abi.py"
spec = importlib.util.spec_from_file_location("files_abi", GENERATOR)
abi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(abi)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--cc", default="cc")
args = parser.parse_args()


class FilesAbiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.content = abi.render(abi.measure(args.cc))

    def run_generator(self, output, *arguments):
        return subprocess.run([sys.executable, str(GENERATOR), "--cc", args.cc,
                               "--output", str(output), *arguments],
                              capture_output=True, text=True, check=False, timeout=60)

    def test_committed_output(self):
        self.assertEqual(abi.OUTPUT.read_bytes(), self.content, "Run the generator on the supported target")

    def test_generation_and_check(self):
        with tempfile.TemporaryDirectory(prefix="polly-files-abi-test-") as temporary:
            output = Path(temporary) / "files.mjs"
            generated = self.run_generator(output)
            self.assertEqual(generated.returncode, 0, generated.stderr)
            self.assertEqual(output.read_bytes(), self.content)
            checked = self.run_generator(output, "--check")
            self.assertEqual(checked.returncode, 0, checked.stderr)
            self.assertEqual(output.read_bytes(), self.content)

    def test_missing_and_stale_check_do_not_write(self):
        with tempfile.TemporaryDirectory(prefix="polly-files-abi-test-") as temporary:
            output = Path(temporary) / "files.mjs"
            missing = self.run_generator(output, "--check")
            self.assertEqual(missing.returncode, 1)
            self.assertIn("missing or stale", missing.stderr)
            self.assertFalse(output.exists())
            output.write_bytes(self.content + b"// stale\n")
            stale = self.run_generator(output, "--check")
            self.assertEqual(stale.returncode, 1)
            self.assertIn("missing or stale", stale.stderr)
            self.assertEqual(output.read_bytes(), self.content + b"// stale\n")

    def test_missing_compiler_does_not_write(self):
        with tempfile.TemporaryDirectory(prefix="polly-files-abi-test-") as temporary:
            output = Path(temporary) / "files.mjs"
            result = self.run_generator(output, "--cc", str(Path(temporary) / "missing-compiler"))
            self.assertEqual(result.returncode, 1)
            self.assertIn("FileSystem ABI generation failed:", result.stderr)
            self.assertFalse(output.exists())

    def test_compiler_target_mismatch_does_not_write(self):
        with tempfile.TemporaryDirectory(prefix="polly-files-abi-test-") as temporary:
            output = Path(temporary) / "files.mjs"
            output.write_bytes(self.content)
            result = self.run_generator(output, "--cc", args.cc + " -D__ILP32__")
            self.assertEqual(result.returncode, 1)
            self.assertIn("compiler target must be Linux x86_64/LP64", result.stderr)
            self.assertEqual(output.read_bytes(), self.content)

    def test_unsupported_target(self):
        for target in ("win32", "darwin"):
            with self.subTest(platform=target), patch.object(abi.sys, "platform", target):
                with self.assertRaisesRegex(ValueError, "requires native Linux x86_64/LP64"):
                    abi.require_native_target()
        with patch.object(abi.platform, "machine", return_value="aarch64"):
            with self.assertRaisesRegex(ValueError, "requires native Linux x86_64/LP64"):
                abi.require_native_target()
        with patch.object(abi.ctypes, "sizeof", return_value=4):
            with self.assertRaisesRegex(ValueError, "requires native Linux x86_64/LP64"):
                abi.require_native_target()
        with patch.object(abi.sys, "byteorder", "big"):
            with self.assertRaisesRegex(ValueError, "requires native Linux x86_64/LP64"):
                abi.require_native_target()


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]])
