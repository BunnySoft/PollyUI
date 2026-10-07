#!/usr/bin/env python3
"""T08.2 explicit test-only Ed25519 identity envelopes, NOT production trust.

OpenSSL supplies Ed25519; this module only validates and frames its inputs.
The embedded T07.1 payload remains development-unsigned. Verification does not
inspect SYSTEM/Dpkg/Apt, replace preflight, prove package origin or authorize
writes. No keys are enrolled, generated, published or implicitly trusted.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile

spec = importlib.util.spec_from_file_location(
    "signature_payload", Path(__file__).resolve().with_name("payload.py"))
payload = importlib.util.module_from_spec(spec)
spec.loader.exec_module(payload)

SCHEMA_VERSION = 1
KIND = "polly-system-payload-test-signature"
ALGORITHM = "Ed25519"
TRUST_CONTEXT = "test-only"
DOMAIN = b"PollyOS payload test signature v1\n"
MAX_JSON_BYTES = payload.MAX_JSON_BYTES + 4096
MAX_ARGUMENT_BYTES = 4096
MAX_ARGUMENTS = 32
OPENSSL_TIMEOUT = 10
# RFC 8410 SubjectPublicKeyInfo and unencrypted PKCS#8, with absent parameters.
PUBLIC_PREFIX = bytes.fromhex("302a300506032b6570032100")
PRIVATE_PREFIX = bytes.fromhex("302e020100300506032b657004220420")
PUBLIC_BYTES = len(PUBLIC_PREFIX) + 32
PRIVATE_BYTES = len(PRIVATE_PREFIX) + 32
FIELDS = ("schemaVersion", "kind", "algorithm", "trustContext", "payload",
          "payloadBytes", "payloadSha256", "publicKeySha256", "signature")


def _context(value):
    payload._equal(value, TRUST_CONTEXT, "test trust context")


def _body(value):
    return payload.encode(value).encode("ascii")


def _signature(value):
    payload._text(value, r"[A-Za-z0-9+/]{86}==", "Ed25519 signature", 88)
    raw = base64.b64decode(value, validate=True)
    if len(raw) != 64 or base64.b64encode(raw).decode("ascii") != value:
        raise ValueError("Non-canonical Ed25519 signature")
    return raw


def validate(value):
    """Validate bounded envelope structure only; this is NOT verification."""
    payload._exact(value, FIELDS, "test signature envelope")
    for key, expected in (("schemaVersion", SCHEMA_VERSION), ("kind", KIND),
                          ("algorithm", ALGORITHM), ("trustContext", TRUST_CONTEXT)):
        payload._equal(value[key], expected, key)
    body = payload.validate(value["payload"])
    raw = _body(body)
    payload._integer(value["payloadBytes"], 1, payload.MAX_JSON_BYTES, "payload bytes")
    payload._equal(value["payloadBytes"], len(raw), "canonical payload length")
    for key in ("payloadSha256", "publicKeySha256"):
        payload._sha(value[key])
    payload._equal(value["payloadSha256"], hashlib.sha256(raw).hexdigest(),
                   "canonical payload digest")
    _signature(value["signature"])
    return {**value, "payload": body}


def encode(value):
    text = payload._canonical(validate(value)) + "\n"
    if len(text) > MAX_JSON_BYTES:
        raise ValueError("Test signature envelope exceeds size limit")
    return text


def decode(text):
    if type(text) is not str or len(text.encode("utf8")) > MAX_JSON_BYTES:
        raise ValueError("Test signature envelope exceeds size limit")
    try:
        value = json.loads(text, object_pairs_hook=payload._pairs,
                           parse_constant=payload._constant)
    except (json.JSONDecodeError, RecursionError) as error:
        raise ValueError("Malformed test signature JSON") from error
    return validate(value)


def signing_bytes(value):
    """Domain-separated canonical ASCII metadata/body plus LF, excluding signature."""
    value = validate(value)
    return DOMAIN + (payload._canonical(
        {key: item for key, item in value.items() if key != "signature"}) + "\n").encode("ascii")


def _key(raw, *, private=False):
    prefix = PRIVATE_PREFIX if private else PUBLIC_PREFIX
    if type(raw) is not bytes or len(raw) != len(prefix) + 32 or not raw.startswith(prefix):
        raise ValueError("Expected exact RFC 8410 Ed25519 " +
                         ("unencrypted PKCS#8 private" if private else "SPKI public") + " DER")
    return raw


def _key_file(path, *, private=False):
    maximum = PRIVATE_BYTES if private else PUBLIC_BYTES
    return _key(payload._read(path, maximum), private=private)


def _openssl(arguments):
    try:
        result = subprocess.run(["openssl", *arguments], stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=OPENSSL_TIMEOUT, check=False, shell=False)
    except FileNotFoundError as error:
        raise ValueError("OpenSSL Ed25519 backend is unavailable") from error
    except subprocess.TimeoutExpired as error:
        raise ValueError("OpenSSL Ed25519 operation timed out") from error
    if result.returncode != 0:
        raise ValueError("OpenSSL Ed25519 operation refused (exit " +
                         str(result.returncode) + ")")
    return result.stdout


def sign(value, test_private_key, *, trust_context):
    """Sign a validated payload using an explicitly supplied ephemeral test DER key."""
    _context(trust_context)
    value = payload.validate(value)
    body = _body(value)
    private = _key_file(test_private_key, private=True)
    with tempfile.TemporaryDirectory(prefix="polly-test-signature-") as temporary:
        directory = Path(temporary)
        key, message = directory / "private.der", directory / "message"
        key.write_bytes(private)
        key.chmod(0o600)
        public = _key(_openssl(["pkey", "-inform", "DER", "-in", str(key),
                                "-pubout", "-outform", "DER"]))
        envelope = {"schemaVersion": SCHEMA_VERSION, "kind": KIND, "algorithm": ALGORITHM,
                    "trustContext": trust_context, "payload": value, "payloadBytes": len(body),
                    "payloadSha256": hashlib.sha256(body).hexdigest(),
                    "publicKeySha256": hashlib.sha256(public).hexdigest(),
                    "signature": base64.b64encode(bytes(64)).decode("ascii")}
        message.write_bytes(signing_bytes(envelope))
        raw = _openssl(["pkeyutl", "-sign", "-rawin", "-keyform", "DER",
                        "-inkey", str(key), "-in", str(message)])
        if len(raw) != 64:
            raise ValueError("OpenSSL returned an invalid Ed25519 signature length")
        envelope["signature"] = base64.b64encode(raw).decode("ascii")
    return validate(envelope)


def verify(value, trusted_test_public_key, *, trust_context, expected_version,
           distribution, architecture):
    """Verify identity under caller-supplied TEST trust; never qualify actual material."""
    _context(trust_context)
    value = validate(value)
    body = value["payload"]
    for key, expected in (("version", expected_version), ("distribution", distribution),
                          ("architecture", architecture)):
        payload._equal(body[key], expected, "expected payload " + key)
    public = _key_file(trusted_test_public_key)
    fingerprint = hashlib.sha256(public).hexdigest()
    payload._equal(value["publicKeySha256"], fingerprint, "trusted test public key")
    with tempfile.TemporaryDirectory(prefix="polly-test-verification-") as temporary:
        directory = Path(temporary)
        key, message, signature = (directory / name for name in ("public.der", "message", "signature"))
        key.write_bytes(public)
        message.write_bytes(signing_bytes(value))
        signature.write_bytes(_signature(value["signature"]))
        _openssl(["pkeyutl", "-verify", "-rawin", "-pubin", "-keyform", "DER",
                  "-inkey", str(key), "-in", str(message), "-sigfile", str(signature)])
    return {"schemaVersion": 1, "kind": "polly-system-payload-test-verification",
            "algorithm": ALGORITHM, "trustContext": trust_context,
            "publicKeySha256": fingerprint, "contractSha256": value["payloadSha256"],
            "contractBytes": value["payloadBytes"], "version": body["version"],
            "architecture": body["architecture"], "payloadTrust": body["trust"],
            "signatureVerified": True, "materialVerified": False, "preflightRequired": True,
            "productionTrusted": False, "writeAuthorized": False, "readOnly": True,
            "authenticated": False, "bootVerified": False}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    if len(argv) > MAX_ARGUMENTS or any(
            len(argument.encode("utf8")) > MAX_ARGUMENT_BYTES or "\x00" in argument for argument in argv):
        parser.error("Arguments exceed test signature bounds")
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("sign-test", allow_abbrev=False)
    create.add_argument("contract", type=Path)
    create.add_argument("--test-private-key", type=Path, required=True)
    check = commands.add_parser("verify-test", allow_abbrev=False)
    check.add_argument("envelope", type=Path)
    check.add_argument("--trusted-test-public-key", type=Path, required=True)
    check.add_argument("--expected-version", required=True)
    check.add_argument("--distribution", required=True, choices=("debian13",))
    check.add_argument("--architecture", required=True, choices=("amd64",))
    for command in (create, check):
        command.add_argument("--trust-context", required=True, choices=(TRUST_CONTEXT,))
    args = parser.parse_args(argv)
    try:
        if args.command == "sign-test":
            value = payload.decode(payload._read(args.contract, payload.MAX_JSON_BYTES).decode("utf8"))
            result = encode(sign(value, args.test_private_key, trust_context=args.trust_context))
        else:
            value = decode(payload._read(args.envelope, MAX_JSON_BYTES).decode("utf8"))
            evidence = verify(value, args.trusted_test_public_key, trust_context=args.trust_context,
                              expected_version=args.expected_version, distribution=payload.DISTRIBUTION,
                              architecture=args.architecture)
            result = payload._canonical(evidence) + "\n"
    except (OSError, ValueError, RecursionError) as error:
        print("Test payload signature refused: " + str(error), file=sys.stderr)
        return 1
    sys.stdout.write(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
