#!/usr/bin/env python3
"""Bounded first-run protocol tests; filesystem/PAM cases use a separate container fixture."""
import importlib.util
from contextlib import nullcontext
from pathlib import Path
import socket
import struct
import os
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


broker = module("greeter_setup", ROOT / "session/setup-broker.py")
launcher = module("greeter_launcher", ROOT / "session/greetd-launch.py")


class Setup(unittest.TestCase):
    def exchange(self, action, completed=False, tool=None):
        server, client = socket.socketpair()
        client.settimeout(3)
        accounts = Mock()
        accounts.completed.return_value = completed
        accounts.state_lock.return_value = nullcontext()
        failures = []

        def serve():
            try:
                with server, patch.object(broker, "password_tool", tool or Mock()):
                    broker.transaction(server, accounts, lambda channel: None)
            except BaseException as error:
                failures.append(error)

        thread = threading.Thread(target=serve)
        thread.start()
        try:
            action(client, accounts)
        finally:
            client.close()
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(failures, [])
        return accounts

    def command(self, channel, operation, first=b"", second=b""):
        channel.sendall(broker.REQUEST.pack(broker.MAGIC, operation, len(first), len(second)) + first + second)

    def reply(self, channel):
        value = channel.recv(broker.REPLY.size, socket.MSG_WAITALL)
        self.assertEqual(len(value), broker.REPLY.size)
        magic, result = broker.REPLY.unpack(value)
        self.assertEqual(magic, broker.MAGIC)
        return result

    def test_status_exports_only_setup_or_login(self):
        for completed in (False, True):
            def action(channel, accounts):
                self.command(channel, broker.STATUS)
                self.assertEqual(self.reply(channel), broker.LOGIN if completed else broker.NEEDS_SETUP)
                accounts.passwords.assert_not_called()
            self.exchange(action, completed)

    def test_prepared_requires_separate_commit(self):
        def action(channel, accounts):
            self.command(channel, broker.SETUP, b"synthetic-polly", b"synthetic-root")
            self.assertEqual(self.reply(channel), broker.POLLY)
            self.assertEqual(self.reply(channel), broker.ROOT)
            self.assertEqual(self.reply(channel), broker.PREPARED)
            accounts.finish.assert_not_called()
            self.command(channel, broker.COMMIT)
            self.assertEqual(self.reply(channel), broker.COMMITTING)
            self.assertEqual(self.reply(channel), broker.COMPLETE)
        accounts = self.exchange(action)
        accounts.finish.assert_called_once()

    def test_cancel_prepared_preserves_incomplete_state(self):
        def action(channel, accounts):
            self.command(channel, broker.SETUP, b"synthetic-polly", b"synthetic-root")
            for result in (broker.POLLY, broker.ROOT, broker.PREPARED):
                self.assertEqual(self.reply(channel), result)
            self.command(channel, broker.CANCEL)
            self.assertEqual(self.reply(channel), broker.CANCELLED)
        accounts = self.exchange(action)
        accounts.finish.assert_not_called()

    def test_second_password_failure_does_not_commit(self):
        def tool(channel, name, token):
            if name == "root":
                raise broker.PasswordPolicyError()
        def action(channel, accounts):
            self.command(channel, broker.SETUP, b"synthetic-polly", b"synthetic-root")
            for result in (broker.POLLY, broker.ROOT, broker.POLICY):
                self.assertEqual(self.reply(channel), result)
        accounts = self.exchange(action, tool=tool)
        accounts.finish.assert_not_called()

    def test_initialized_state_cannot_reset_passwords(self):
        tool = Mock()
        def action(channel, accounts):
            self.command(channel, broker.SETUP, b"synthetic-polly", b"synthetic-root")
            self.assertEqual(self.reply(channel), broker.UNAVAILABLE)
        accounts = self.exchange(action, True, tool)
        tool.assert_not_called()
        accounts.finish.assert_not_called()

    def test_equal_or_multiline_passwords_never_start_password_tool(self):
        for first, second in ((b"same", b"same"), (b"line\nbreak", b"root"), (b"polly", b"nul\0byte")):
            tool = Mock()
            def action(channel, accounts):
                self.command(channel, broker.SETUP, first, second)
                self.assertEqual(self.reply(channel), broker.UNAVAILABLE if first == second else broker.POLICY)
            self.exchange(action, tool=tool)
            tool.assert_not_called()

    def test_ascii_controls_and_delete_never_reach_password_tool_or_initialize_state(self):
        with patch.object(broker.sys, "stderr"):
            for value in (*range(32), 127):
                for name in ("polly", "root"):
                    tool = Mock()
                    passwords = {"polly": b"synthetic-polly", "root": b"synthetic-root"}
                    passwords[name] += bytes([value])
                    def action(channel, accounts):
                        self.command(channel, broker.SETUP, passwords["polly"], passwords["root"])
                        self.assertEqual(self.reply(channel), broker.POLICY)
                    accounts = self.exchange(action, tool=tool)
                    tool.assert_not_called()
                    accounts.finish.assert_not_called()

    def test_bounded_header_rejects_arbitrary_operations_targets_and_lengths(self):
        for request in ((broker.MAGIC, 99, 0, 0), (0, broker.STATUS, 0, 0),
                        (broker.MAGIC, broker.SETUP, 1025, 1),
                        (broker.MAGIC, broker.STATUS, 1, 0)):
            def action(channel, accounts):
                channel.sendall(struct.pack("=IIII", *request))
                self.assertEqual(self.reply(channel), broker.UNAVAILABLE)
            accounts = self.exchange(action)
            accounts.finish.assert_not_called()

    def test_native_and_python_protocol_values_match(self):
        header = (ROOT / "session/greeter-protocol.h").read_text()
        self.assertIn("0x50475231", header)
        self.assertIn("1024u", header)
        self.assertIn(broker.SOCKET, header)

    def test_service_requires_kernel_peer_and_all_seat_properties(self):
        authority = broker.SeatAuthority()
        greeter = Mock(pw_uid=991, pw_gid=991)
        channel = Mock()
        channel.getsockopt.return_value = struct.pack("=iII", 123, 991, 991)
        def text(name, argument):
            return {"sd_pid_get_session": b"fixture", "sd_session_get_class": b"greeter",
                    "sd_session_get_seat": b"seat0", "sd_session_get_type": b"wayland",
                    "sd_session_get_tty": b"tty1"}[name]
        def session_uid(session, output):
            output._obj.value = 991
            return 0
        with patch.object(broker.pwd, "getpwnam", return_value=greeter), \
                patch.object(broker.os, "pidfd_open", return_value=10), \
                patch.object(broker.os, "close"), patch.object(broker.select, "select", return_value=([], [], [])), \
                patch.object(authority, "text", side_effect=text), \
                patch.object(authority.systemd, "sd_session_get_uid", side_effect=session_uid), \
                patch.object(authority.systemd, "sd_session_is_active", return_value=1), \
                patch.object(authority.systemd, "sd_session_is_remote", return_value=0):
            authority.authorize(channel)
            for uid in (0, 1000):
                channel.getsockopt.return_value = struct.pack("=iII", 123, uid, 991)
                with self.assertRaises(PermissionError):
                    authority.authorize(channel)
            channel.getsockopt.return_value = struct.pack("=iII", 123, 991, 991)
            with patch.object(authority.systemd, "sd_session_is_active", return_value=0):
                with self.assertRaises(PermissionError):
                    authority.authorize(channel)
            with patch.object(authority.systemd, "sd_session_is_remote", return_value=1):
                with self.assertRaises(PermissionError):
                    authority.authorize(channel)
            for property_name in ("sd_session_get_class", "sd_session_get_seat",
                                  "sd_session_get_type", "sd_session_get_tty"):
                with patch.object(authority, "text", side_effect=lambda name, arg:
                                  b"invalid" if name == property_name else text(name, arg)):
                    with self.assertRaises(PermissionError):
                        authority.authorize(channel)


@unittest.skipUnless(os.geteuid() == 0, "launcher files require a disposable root runner")
class Launcher(unittest.TestCase):
    def exercise(self, policy, completed, action):
        accounts = module("greeter_accounts_unit", ROOT / "release/install/accounts.py")
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            runtime = directory / "accounts"
            runtime.mkdir(mode=0o700)
            accounts.atomic(runtime / "automatic-login", policy, 0o600)
            base, config = directory / "base.conf", directory / "greetd.conf"
            base.write_text((ROOT / "session/greetd.conf").read_text())
            with patch.object(launcher, "BASE", base), patch.object(launcher, "CONFIG", config), \
                    patch.object(accounts, "RUNTIME", runtime), \
                    patch.object(accounts, "require_ready") as ready, \
                    patch.object(accounts, "completed", return_value=completed):
                action(accounts, runtime, config, ready)

    def test_default_and_incomplete_accounts_never_enable_autologin(self):
        for policy, completed in (("off\n", False), ("off\n", True), ("on\n", False)):
            def action(accounts, runtime, config, ready):
                launcher.configure(accounts)
                self.assertNotIn("[initial_session]", config.read_text())
                self.assertFalse((runtime / "autologin-used").exists())
            self.exercise(policy, completed, action)

    def test_explicit_completed_boot_policy_is_consumed_once(self):
        def action(accounts, runtime, config, ready):
            launcher.configure(accounts)
            self.assertIn("[initial_session]", config.read_text())
            self.assertIn('user = "polly"', config.read_text())
            self.assertEqual((runtime / "autologin-used").stat().st_mode & 0o777, 0o600)
            self.assertIn(unittest.mock.call(), ready.call_args_list)
            launcher.configure(accounts)
            self.assertNotIn("[initial_session]", config.read_text())
            self.assertEqual((runtime / "autologin-used").read_text(), "")
        self.exercise("on\n", True, action)

    def test_bad_boot_policy_and_unsafe_marker_are_refused(self):
        def bad(accounts, runtime, config, ready):
            with self.assertRaises(ValueError):
                launcher.configure(accounts)
            self.assertFalse(config.exists())
        self.exercise("invalid\n", True, bad)
        def unsafe(accounts, runtime, config, ready):
            (runtime / "autologin-used").write_text("")
            (runtime / "autologin-used").chmod(0o644)
            with self.assertRaises(ValueError):
                launcher.configure(accounts)
            self.assertFalse(config.exists())
        self.exercise("on\n", True, unsafe)


if __name__ == "__main__":
    unittest.main()
