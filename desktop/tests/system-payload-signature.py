#!/usr/bin/env python3
"""T08.2 ephemeral test keys and synthetic fixtures; no network, mounts or real keys."""
import ast
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
MODULE = REPO / "desktop/release/maintenance/signature.py"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


signature = load("test_payload_signature", MODULE)
payload = signature.payload


def openssl(*args):
    return subprocess.run(["openssl", *map(str, args)], stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=True).stdout


def synthetic_contract():
    materials = [{"id": identifier, "role": role, "path": path,
                  "inventorySha256": str(index + 1) * 64,
                  "nodes": 1, "contentBytes": 1, "measuredBytes": 4096}
                 for index, (identifier, role, path) in enumerate(payload.MATERIALS)]
    capacity = []
    for role in ("SYSTEM", "PERSISTENT"):
        measured = sum(item["measuredBytes"] for item in materials if item["role"] == role)
        capacity.append({"role": role, "payloadBytes": measured, "overheadBytes": 16 * payload.layout.MIB,
                         "reserveBytes": 32 * payload.layout.MIB,
                         "minimumBytes": measured + 48 * payload.layout.MIB})
    return payload.validate({
        "schemaVersion": 1, "kind": "polly-system-payload", "version": "1.2.3",
        "distribution": dict(payload.DISTRIBUTION), "architecture": "amd64",
        "storageSchemaVersion": 1, "trust": "development-unsigned", "materials": materials,
        "packageProof": {"qualification": payload.QUALIFICATION,
                         "inventory": {"path": payload.INVENTORY_PATH, "bytes": 1, "sha256": "4" * 64},
                         "status": {"path": payload.STATUS_PATH, "bytes": 1, "sha256": "5" * 64},
                         "packagesSha256": "6" * 64, "records": 1, "installedRecords": 1,
                         "runtimePaths": 1, "runtimeFileChecksums": 1, "diversions": 0},
        "capacity": capacity,
        "compatibility": [{"id": identifier, "policy": policy, "acceptsSchemas": []}
                          for identifier, policy in payload.DATA_POLICIES]})


class PayloadSignature(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="polly-t082-keys-")
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.keys = Path(cls.temporary.name)
        cls.private, cls.public = cls.keys / "test-private.der", cls.keys / "test-public.der"
        cls.other_private, cls.other_public = cls.keys / "other-private.der", cls.keys / "other-public.der"
        for private, public in ((cls.private, cls.public), (cls.other_private, cls.other_public)):
            openssl("genpkey", "-algorithm", "Ed25519", "-outform", "DER", "-out", private)
            private.chmod(0o600)
            public.write_bytes(openssl("pkey", "-inform", "DER", "-in", private, "-pubout", "-outform", "DER"))
        cls.contract = synthetic_contract()
        cls.envelope = signature.sign(cls.contract, cls.private, trust_context="test-only")

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="polly-t082-inputs-")
        self.addCleanup(self.temporary.cleanup)
        self.stage = Path(self.temporary.name)
        self.value = copy.deepcopy(self.envelope)

    def verify(self, value=None, key=None, **kwargs):
        options = {"trust_context": "test-only", "expected_version": "1.2.3",
                   "distribution": dict(payload.DISTRIBUTION), "architecture": "amd64"}
        options.update(kwargs)
        return signature.verify(self.value if value is None else value,
                                self.public if key is None else key, **options)

    def repair_body_metadata(self):
        raw = payload.encode(self.value["payload"]).encode("ascii")
        self.value.update(payloadBytes=len(raw), payloadSha256=hashlib.sha256(raw).hexdigest())

    def cli(self, *args, **kwargs):
        return subprocess.run([sys.executable, "-I", "-B", str(MODULE), *map(str, args)],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=30, check=False, **kwargs)

    def verify_args(self, path, **kwargs):
        options = {"--trusted-test-public-key": self.public, "--trust-context": "test-only",
                   "--expected-version": "1.2.3", "--distribution": "debian13", "--architecture": "amd64"}
        options.update(kwargs)
        return ["verify-test", path, *(item for pair in options.items() for item in pair)]

    def assert_cli_refused(self, result, prefix=b"Test payload signature refused:"):
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")
        self.assertIn(prefix, result.stderr)

    def test_deterministic_signature_codec_and_independent_copies(self):
        again = signature.sign(self.contract, self.private, trust_context="test-only")
        self.assertEqual(again, self.envelope)
        text = signature.encode(self.value)
        self.assertTrue(text.isascii())
        self.assertTrue(text.endswith("\n"))
        self.assertEqual(signature.decode(text), self.envelope)
        decoded = signature.decode(text)
        decoded["payload"]["materials"][0]["nodes"] = 2
        self.assertEqual(self.envelope["payload"]["materials"][0]["nodes"], 1)
        self.assertEqual(self.contract["trust"], "development-unsigned")
        self.assertEqual(set(self.envelope), set(signature.FIELDS))
        self.assertNotIn("publicKey", self.envelope)

    def test_exact_canonical_body_and_domain_bytes_interoperate_with_openssl(self):
        body = (json.dumps(self.contract, sort_keys=True, separators=(",", ":"),
                           ensure_ascii=True) + "\n").encode("ascii")
        signed = b"PollyOS payload test signature v1\n" + (json.dumps(
            {key: value for key, value in self.envelope.items() if key != "signature"},
            sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii")
        self.assertEqual(self.envelope["payloadBytes"], len(body))
        self.assertEqual(self.envelope["payloadSha256"], hashlib.sha256(body).hexdigest())
        self.assertEqual(signature.signing_bytes(self.envelope), signed)
        self.assertEqual(self.public.stat().st_size, 44)
        self.assertEqual(self.private.stat().st_size, 48)
        self.assertEqual(len(base64.b64decode(self.envelope["signature"])), 64)
        message, raw_signature = self.stage / "message", self.stage / "signature"
        message.write_bytes(signed)
        raw_signature.write_bytes(base64.b64decode(self.envelope["signature"]))
        self.assertIn(b"Signature Verified", openssl(
            "pkeyutl", "-verify", "-rawin", "-pubin", "-keyform", "DER",
            "-inkey", self.public, "-in", message, "-sigfile", raw_signature))
        self.assertEqual(openssl("pkeyutl", "-sign", "-rawin", "-keyform", "DER",
                                 "-inkey", self.private, "-in", message), raw_signature.read_bytes())

    def test_exact_evidence_shape_never_promotes_unsigned_payload(self):
        fingerprint = hashlib.sha256(self.public.read_bytes()).hexdigest()
        self.assertEqual(self.verify(), {
            "schemaVersion": 1, "kind": "polly-system-payload-test-verification",
            "algorithm": "Ed25519", "trustContext": "test-only", "publicKeySha256": fingerprint,
            "contractSha256": self.envelope["payloadSha256"], "contractBytes": self.envelope["payloadBytes"],
            "version": "1.2.3", "architecture": "amd64", "payloadTrust": "development-unsigned",
            "signatureVerified": True, "materialVerified": False, "preflightRequired": True,
            "productionTrusted": False, "writeAuthorized": False, "readOnly": True,
            "authenticated": False, "bootVerified": False})
        self.assertEqual(self.verify(), self.verify())

    def test_external_wrong_key_and_repaired_key_fingerprint_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "trusted test public key"):
            self.verify(key=self.other_public)
        self.value["publicKeySha256"] = hashlib.sha256(self.other_public.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, "OpenSSL.*refused"):
            self.verify(key=self.other_public)
        other = signature.sign(self.contract, self.other_private, trust_context="test-only")
        self.assertNotEqual(other["signature"], self.envelope["signature"])
        with self.assertRaises(ValueError):
            self.verify(other)

    def test_wrong_signature_and_wrong_domain_are_rejected(self):
        raw = bytearray(base64.b64decode(self.envelope["signature"]))
        raw[0] ^= 1
        self.value["signature"] = base64.b64encode(raw).decode("ascii")
        with self.assertRaisesRegex(ValueError, "OpenSSL.*refused"):
            self.verify()
        self.value = copy.deepcopy(self.envelope)
        message = self.stage / "foreign-message"
        message.write_bytes(signature.signing_bytes(self.value).replace(
            b"PollyOS payload test signature v1\n", b"Other protocol\n", 1))
        self.value["signature"] = base64.b64encode(openssl(
            "pkeyutl", "-sign", "-rawin", "-keyform", "DER",
            "-inkey", self.private, "-in", message)).decode("ascii")
        with self.assertRaisesRegex(ValueError, "OpenSSL.*refused"):
            self.verify()

    def test_valid_body_tampering_fails_even_after_digest_and_length_repair(self):
        mutations = (
            lambda v: v.update(version="1.2.4"),
            lambda v: v["materials"][0].update(inventorySha256="7" * 64),
            lambda v: v["materials"][1].update(inventorySha256="8" * 64),
            lambda v: v["materials"][2].update(inventorySha256="9" * 64),
            lambda v: v["materials"][0].update(nodes=2),
            lambda v: v["packageProof"]["status"].update(sha256="a" * 64),
            lambda v: v["packageProof"].update(packagesSha256="b" * 64),
            lambda v: v["compatibility"][0].update(acceptsSchemas=[3]),
            lambda v: v["capacity"][0].update(
                reserveBytes=v["capacity"][0]["reserveBytes"] + 1,
                minimumBytes=v["capacity"][0]["minimumBytes"] + 1),
        )
        for mutation in mutations:
            self.value = copy.deepcopy(self.envelope)
            mutation(self.value["payload"])
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                self.verify(expected_version=self.value["payload"]["version"])
            self.repair_body_metadata()
            with self.subTest(repaired=mutation), self.assertRaisesRegex(ValueError, "OpenSSL.*refused"):
                self.verify(expected_version=self.value["payload"]["version"])

    def test_metadata_shape_types_versions_digests_lengths_and_arch_rejected(self):
        mutations = (
            lambda v: v.update(extra="unknown"),
            lambda v: v.pop("signature"),
            lambda v: v.update(schemaVersion=True),
            lambda v: v.update(schemaVersion=2),
            lambda v: v.update(kind="polly-system-payload"),
            lambda v: v.update(algorithm="RSA"),
            lambda v: v.update(trustContext="production"),
            lambda v: v.update(payloadBytes=True),
            lambda v: v.update(payloadBytes=0),
            lambda v: v.update(payloadBytes=v["payloadBytes"] + 1),
            lambda v: v.update(payloadBytes=payload.MAX_JSON_BYTES + 1),
            lambda v: v.update(payloadBytes=float(v["payloadBytes"])),
            lambda v: v.update(payloadSha256="0" * 64),
            lambda v: v.update(publicKeySha256="A" * 64),
            lambda v: v.update(publicKeySha256=True),
            lambda v: v.update(publicKeySha256="a" * 63),
            lambda v: v.update(payload=[]),
            lambda v: v["payload"].update(schemaVersion=True),
            lambda v: v["payload"].update(schemaVersion=2),
            lambda v: v["payload"].update(trust="production-signed"),
            lambda v: v["payload"].update(architecture="x86_64"),
            lambda v: v["payload"].update(architecture="arm64"),
            lambda v: v["payload"].update(architecture=False),
            lambda v: v["payload"].update(version="01.2.3"),
            lambda v: v["payload"].update(version=True),
            lambda v: v["payload"]["materials"][0].update(path="../SYSTEM"),
            lambda v: v["payload"]["materials"][0].update(nodes=True),
            lambda v: v["payload"]["materials"][0].update(contentBytes=payload.MAX_BYTES + 1),
            lambda v: v["payload"]["capacity"][0].update(minimumBytes=True),
            lambda v: v["payload"]["compatibility"][0].update(acceptsSchemas=[True]),
        )
        for mutation in mutations:
            value = copy.deepcopy(self.envelope)
            mutation(value)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                signature.validate(value)

    def test_signature_encoding_is_exact_not_merely_decodable(self):
        cases = ("", True, "A" * 87, "A" * 89, "_" * 86 + "==",
                 base64.b64encode(bytes(63)).decode("ascii"),
                 base64.b64encode(bytes(65)).decode("ascii"),
                 "A" * 85 + "B==", self.envelope["signature"] + "\n")
        for value in cases:
            self.value["signature"] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                signature.validate(self.value)

    def test_json_malformed_duplicates_and_nonfinite_numbers_are_rejected(self):
        text = signature.encode(self.envelope)
        cases = (
            "{", "[]", "null", "true", text + "{}",
            text.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1', 1),
            text.replace('"id":"debian"', '"id":"debian","id":"debian"', 1),
            text.replace('"nodes":1', '"nodes":1,"nodes":1', 1),
            text.replace('"payloadBytes":', '"payloadBytes":NaN,"other":', 1),
            text.replace('"payloadBytes":', '"payloadBytes":Infinity,"other":', 1),
            "[" * 2000 + "]" * 2000,
            '{"schemaVersion":' + "9" * 5000 + "}",
            "\ud800", b"{}", None,
        )
        for value in cases:
            with self.subTest(text=str(value)[:80]), self.assertRaises(ValueError):
                signature.decode(value)

    def test_source_size_utf8_and_canonical_size_boundaries(self):
        text = signature.encode(self.envelope)
        boundary = text + " " * (signature.MAX_JSON_BYTES - len(text.encode("utf8")))
        self.assertEqual(signature.decode(boundary), self.envelope)
        with self.assertRaisesRegex(ValueError, "size limit"):
            signature.decode(boundary + " ")
        with self.assertRaisesRegex(ValueError, "size limit"):
            signature.decode(boundary + "\u00e9")
        with patch.object(signature, "MAX_JSON_BYTES", len(text)):
            self.assertEqual(signature.encode(self.envelope), text)
        with patch.object(signature, "MAX_JSON_BYTES", len(text) - 1):
            with self.assertRaisesRegex(ValueError, "size limit"):
                signature.encode(self.envelope)
        body = payload.encode(self.contract)
        with patch.object(payload, "MAX_JSON_BYTES", len(body)):
            self.verify()
        with patch.object(payload, "MAX_JSON_BYTES", len(body) - 1):
            with self.assertRaisesRegex(ValueError, "size limit"):
                signature.validate(self.envelope)
        reformatted = json.dumps(self.envelope, indent=2)
        self.assertEqual(self.verify(signature.decode(reformatted)), self.verify())
        self.assertEqual(signature.encode(signature.decode(reformatted)), text)

    def test_missing_or_non_test_context_and_expected_identity_fail_before_crypto(self):
        with self.assertRaises(TypeError):
            signature.sign(self.contract, self.private)
        with self.assertRaises(TypeError):
            signature.verify(self.envelope, self.public)
        for context in ("production", "", None, True):
            with self.subTest(context=context), self.assertRaises(ValueError):
                signature.sign(self.contract, self.stage / "missing", trust_context=context)
            with self.assertRaises(ValueError):
                self.verify(trust_context=context)
        for options in ({"expected_version": "1.2.4"}, {"expected_version": True},
                        {"architecture": "x86_64"}, {"architecture": None},
                        {"distribution": {**payload.DISTRIBUTION, "version": "12"}}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.verify(**options)
        unsigned = self.contract
        with self.assertRaises(ValueError):
            self.verify(unsigned)
        with self.assertRaises(ValueError):
            signature.sign({**unsigned, "trust": "production-signed"},
                           self.stage / "missing", trust_context="test-only")

    def test_only_bounded_exact_ed25519_der_keys_are_accepted(self):
        for private in (False, True):
            valid = (self.private if private else self.public).read_bytes()
            path = self.stage / "key"
            cases = (b"", valid[:-1], valid + b"x", valid[0:6] + b"\x6e" + valid[7:],
                     self.public.read_bytes() if private else self.private.read_bytes(),
                     b"-----BEGIN PUBLIC KEY-----\n" + base64.b64encode(valid) + b"\n",
                     b"x" * 4097)
            for raw in cases:
                path.write_bytes(raw)
                with self.subTest(private=private, bytes=len(raw)), self.assertRaises(ValueError):
                    signature._key_file(path, private=private)
            path.write_bytes(valid)
            self.assertEqual(signature._key_file(path, private=private), valid)

    def test_key_paths_traversal_symlinks_directories_and_special_files_refused(self):
        key = self.stage / "key"
        key.write_bytes(self.public.read_bytes())
        (self.stage / "sub").mkdir()
        (self.stage / "link").symlink_to(key)
        (self.stage / "linked-dir").symlink_to(self.stage / "sub", target_is_directory=True)
        os.mkfifo(self.stage / "fifo")
        paths = (self.stage / "sub" / ".." / "key", self.stage / "link", self.stage,
                 self.stage / "fifo", self.stage / "linked-dir" / "key")
        for path in paths:
            with self.subTest(path=path), self.assertRaises(ValueError):
                signature._key_file(path)
        with self.assertRaises(OSError):
            signature._key_file(self.stage / "missing")

    def test_key_inputs_are_snapshotted_before_backend_and_invocation_is_fixed(self):
        key = self.stage / "-key;touch sentinel"
        key.write_bytes(self.public.read_bytes())
        original = signature._openssl
        observed = []

        def inspect(arguments):
            observed.append(arguments)
            temporary_key = Path(arguments[arguments.index("-inkey") + 1])
            self.assertNotEqual(temporary_key, key)
            self.assertEqual(temporary_key.read_bytes(), self.public.read_bytes())
            key.write_bytes(self.other_public.read_bytes())
            return original(arguments)

        with patch.object(signature, "_openssl", side_effect=inspect):
            self.verify(key=key)
        self.assertEqual(len(observed), 1)
        self.assertEqual(observed[0][:6], ["pkeyutl", "-verify", "-rawin", "-pubin", "-keyform", "DER"])
        self.assertFalse((self.stage / "sentinel").exists())
        with patch.object(signature.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"", b"")) as run:
            signature._openssl(["pkeyutl", "-verify"])
        self.assertEqual(run.call_args.args[0], ["openssl", "pkeyutl", "-verify"])
        self.assertIs(run.call_args.kwargs["shell"], False)
        self.assertEqual(run.call_args.kwargs["timeout"], 10)
        self.assertEqual(run.call_args.kwargs["stdin"], subprocess.DEVNULL)

    def test_missing_timeout_failed_and_malformed_backend_never_succeed(self):
        errors = (FileNotFoundError("missing"), subprocess.TimeoutExpired(["openssl"], 10))
        for error in errors:
            with patch.object(signature.subprocess, "run", side_effect=error):
                with self.subTest(error=error), self.assertRaises(ValueError):
                    self.verify()
        with patch.object(signature.subprocess, "run",
                          return_value=subprocess.CompletedProcess([], 2, b"", b"failure")):
            with self.assertRaisesRegex(ValueError, "refused"):
                self.verify()
        original = signature._openssl

        def malformed(arguments):
            return b"bad" if "-sign" in arguments else original(arguments)

        with patch.object(signature, "_openssl", side_effect=malformed):
            with self.assertRaisesRegex(ValueError, "signature length"):
                signature.sign(self.contract, self.private, trust_context="test-only")

    def test_cli_deterministic_sign_and_verify_success_shapes(self):
        contract, envelope = self.stage / "contract", self.stage / "envelope"
        contract.write_text(json.dumps(self.contract, indent=2))
        signed = self.cli("sign-test", contract, "--test-private-key", self.private,
                          "--trust-context", "test-only")
        self.assertEqual(signed.returncode, 0, signed.stderr)
        self.assertEqual(signed.stderr, b"")
        self.assertEqual(signed.stdout, signature.encode(self.envelope).encode("ascii"))
        envelope.write_bytes(signed.stdout)
        verified = self.cli(*self.verify_args(envelope))
        self.assertEqual(verified.returncode, 0, verified.stderr)
        self.assertEqual(verified.stderr, b"")
        self.assertEqual(verified.stdout, (payload._canonical(self.verify()) + "\n").encode("ascii"))

    def test_cli_refusals_emit_only_stderr_and_nonzero(self):
        envelope = self.stage / "envelope"
        cases = (self.contract, {**self.envelope, "signature": base64.b64encode(bytes(64)).decode("ascii")},
                 {**self.envelope, "schemaVersion": True}, {**self.envelope, "payloadSha256": "0" * 64})
        for value in cases:
            envelope.write_text(json.dumps(value))
            with self.subTest(value=value.get("kind")):
                self.assert_cli_refused(self.cli(*self.verify_args(envelope)))
        envelope.write_text(signature.encode(self.envelope))
        for options in ({"--trusted-test-public-key": self.other_public},
                        {"--expected-version": "1.2.4"},
                        {"--trusted-test-public-key": self.stage / "missing"}):
            self.assert_cli_refused(self.cli(*self.verify_args(envelope, **options)))
        envelope.write_bytes(b"\xff")
        self.assert_cli_refused(self.cli(*self.verify_args(envelope)))
        envelope.write_text(signature.encode(self.envelope).replace(
            '"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1', 1))
        self.assert_cli_refused(self.cli(*self.verify_args(envelope)))

    def test_cli_sign_payload_source_bounds_and_invalid_private_key_refused(self):
        contract, key = self.stage / "contract", self.stage / "private.der"
        raw = payload.encode(self.contract).encode("ascii")
        contract.write_bytes(raw + b" " * (payload.MAX_JSON_BYTES - len(raw)))
        args = ("sign-test", contract, "--test-private-key", self.private, "--trust-context", "test-only")
        result = self.cli(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, signature.encode(self.envelope).encode("ascii"))
        with contract.open("ab") as source:
            source.write(b" ")
        self.assert_cli_refused(self.cli(*args))
        contract.write_bytes(raw)
        for data in (b"", self.public.read_bytes(), self.private.read_bytes() + b"x"):
            key.write_bytes(data)
            self.assert_cli_refused(self.cli("sign-test", contract, "--test-private-key", key,
                                            "--trust-context", "test-only"))
        contract.write_text('{"schemaVersion":1,"stage":"development-single-system-normal-boot"}')
        self.assert_cli_refused(self.cli(*args))

    def test_cli_source_and_argument_bounds_no_unsigned_or_abbreviated_switch(self):
        envelope = self.stage / "envelope"
        raw = signature.encode(self.envelope).encode("ascii")
        envelope.write_bytes(raw + b" " * (signature.MAX_JSON_BYTES - len(raw)))
        result = self.cli(*self.verify_args(envelope))
        self.assertEqual(result.returncode, 0, result.stderr)
        with envelope.open("ab") as source:
            source.write(b" ")
        self.assert_cli_refused(self.cli(*self.verify_args(envelope)))
        cases = ([], ["verify-test", envelope], ["verify-test", envelope, "--allow-unsigned"],
                 ["sign-test", envelope, "--test-private-key", self.private],
                 ["verify-test", envelope, "--trust-context", "production"],
                 ["verify-test", envelope, "--trust", "test-only"],
                 ["x"] * 33, ["x" * 4097])
        for args in cases:
            with self.subTest(args=str(args)[:90]):
                self.assert_cli_refused(self.cli(*args), prefix=b"error:")
        envelope.write_bytes(raw)
        self.assert_cli_refused(self.cli(*self.verify_args(envelope), env={**os.environ, "PATH": str(self.stage)}))

    def test_signature_does_not_substitute_for_real_material_preflight(self):
        fixtures = load("test_signature_payload_fixtures", REPO / "desktop/tests/system-payload.py")
        fixture = fixtures.SystemPayload("test_codec_and_evidence_are_deterministic")
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        signed = signature.sign(fixture.value, self.private, trust_context="test-only")
        options = {"expected_version": fixtures.VERSION}
        verified = self.verify(signed, **options)
        self.assertTrue(verified["preflightRequired"])
        self.assertFalse(verified["materialVerified"])
        self.assertFalse(fixture.preflight(signed["payload"])["authenticated"])
        fixture.program.write_bytes(b"tampered actual runtime")
        self.assertTrue(self.verify(signed, **options)["signatureVerified"])
        with self.assertRaisesRegex(ValueError, "runtime checksum|identity mismatch"):
            fixture.preflight(signed["payload"])
        fixture.program.write_bytes(b"complete native runtime")
        with self.assertRaisesRegex(ValueError, "Insufficient"):
            fixture.preflight(signed["payload"], available_bytes={"SYSTEM": 0, "PERSISTENT": 0})
        with self.assertRaisesRegex(ValueError, "Unqualified data"):
            fixture.preflight(signed["payload"], current_schemas={**fixtures.CURRENT, "accounts": 2})

    def test_source_syntax_and_scope(self):
        ast.parse(MODULE.read_text(), filename=str(MODULE))
        ast.parse(Path(__file__).read_text(), filename=__file__)
        self.assertEqual(signature.KIND, "polly-system-payload-test-signature")
        self.assertEqual(signature.TRUST_CONTEXT, "test-only")


if __name__ == "__main__":
    unittest.main()
