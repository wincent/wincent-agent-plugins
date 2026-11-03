"""Migration tests use synthetic grants only, never the host's Keychain."""

import contextlib
import io
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import types
import unittest
from unittest import mock

from mcp_auth_fixture import FakeKeychain, load_auth

BIN = Path(__file__).resolve().parents[1] / 'bin'
sys.path.insert(0, str(BIN))
import mcp_auth_keychain as keychain


class MigrationTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='mcp-migration-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.addCleanup(mock.patch.stopall)
        mock.patch.dict(os.environ, {'HOME': str(self.root), 'XDG_STATE_HOME': str(self.root)}, clear=True).start()
        mock.patch.object(keychain.ctypes, 'CDLL', side_effect=AssertionError('No host Keychain access')).start()
        for signum in (signal.SIGALRM, signal.SIGTERM):
            self.addCleanup(signal.signal, signum, signal.getsignal(signum))
        self.cases = []
        for name in ['datadog', 'google-workspace']:
            auth = load_auth(BIN / f'{name}-mcp-auth', fake_keychain=False)
            native = auth.Keychain
            mock.patch.object(auth, 'Keychain', side_effect=FakeKeychain).start()
            mock.patch.object(auth, 'request_json', side_effect=AssertionError('Unexpected network request')).start()
            mock.patch.object(auth.webbrowser, 'open', side_effect=AssertionError('Unexpected browser launch')).start()
            tokens = {'accessToken': 'synthetic-access', 'refreshToken': 'synthetic-refresh',
                      'expiresAt': time.time() * 1000 + 3_600_000}
            if name == 'datadog':
                resource = auth.DEFAULT_DOMAIN
                env = {'DATADOG_MCP_DOMAIN': resource}
                filename, value = 'tokens.json', tokens
                read = lambda directory, auth=auth: auth.read_tokens(directory)
                write = lambda directory, value, auth=auth: auth.write_tokens(directory, value)
            else:
                resource = 'https://workspace.example.invalid/mcp'
                env = {'GOOGLE_WORKSPACE_MCP_URL': resource}
                client = {'clientId': 'synthetic-client', 'resourceUri': resource, 'issuer': resource[:-4],
                          'tokenEndpointAuthMethod': 'none', 'redirectUri': auth.callback_url(),
                          'scope': ' '.join(auth.SCOPES)}
                tokens.update(clientId=client['clientId'], resourceUri=resource, scope=client['scope'])
                filename, value = 'grant.json', {'client': client, 'tokens': tokens}
                read = lambda directory, auth=auth, resource=resource: auth.read_grant(directory, resource)
                write = lambda directory, value, auth=auth, resource=resource: auth.write_grant(directory, value, resource)
            self.cases.append(types.SimpleNamespace(name=name, auth=auth, native=native, env=env,
                              resource=resource, directory=auth.store_directory(resource), filename=filename,
                              value=value, read=read, write=write))

    def legacy(self, case, raw=None):
        with case.auth.locked(case.directory):
            path = case.directory / case.filename
            with os.fdopen(case.auth.private_open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC), 'wb') as file:
                file.write(json.dumps(case.value).encode() if raw is None else raw)
        return path

    def main(self, case, *args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, case.env), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = case.auth.main(list(args))
        return code, stdout.getvalue(), stderr.getvalue()

    def test_status_migrates_verified_grant_without_network_or_secret_output(self):
        for case in self.cases:
            with self.subTest(helper=case.name):
                path = self.legacy(case)
                code, stdout, stderr = self.main(case, 'status')
                self.assertEqual(code, 0, stderr)
                self.assertEqual(json.loads(stdout)['state'], 'access_token_valid')
                self.assertNotIn('synthetic', stdout + stderr)
                self.assertFalse(path.exists())
                self.assertEqual(case.read(case.directory), case.value)
                case.auth.request_json.assert_not_called()

    def test_invalid_legacy_grant_is_not_migrated_or_deleted(self):
        for case in self.cases:
            with self.subTest(helper=case.name):
                bad = json.loads(json.dumps(case.value))
                if case.name == 'datadog':
                    bad['accessToken'] = ''
                else:
                    bad['tokens']['clientId'] = 'wrong-client'
                path = self.legacy(case, json.dumps(bad).encode())
                before = path.read_bytes()
                with mock.patch.object(FakeKeychain, 'write', side_effect=AssertionError('Do not save invalid grants')):
                    code, stdout, stderr = self.main(case, 'token')
                self.assertEqual((code, stdout), (1, ''))
                self.assertNotIn('synthetic', stderr)
                self.assertEqual(path.read_bytes(), before)

    def test_keychain_read_and_write_failures_preserve_legacy_and_release_no_token(self):
        for case in self.cases:
            path = self.legacy(case)
            before = path.read_bytes()
            for method in ['read', 'write']:
                with self.subTest(helper=case.name, method=method), mock.patch.object(
                        FakeKeychain, method, side_effect=keychain.AuthError('Keychain unavailable')):
                    code, stdout, stderr = self.main(case, 'token')
                self.assertEqual((code, stdout), (1, ''))
                self.assertNotIn('synthetic', stderr)
                self.assertEqual(path.read_bytes(), before)
            case.auth.request_json.assert_not_called()

    def test_readback_mismatch_keeps_legacy_and_retry_uses_saved_keychain(self):
        for case in self.cases:
            with self.subTest(helper=case.name):
                path = self.legacy(case)
                with mock.patch.object(FakeKeychain, 'read', return_value=None):
                    code, stdout, stderr = self.main(case, 'token')
                self.assertEqual((code, stdout), (1, ''))
                self.assertIn('verification failed', stderr)
                self.assertTrue(path.exists())
                with mock.patch.object(FakeKeychain, 'write', side_effect=AssertionError('Do not overwrite saved grant')):
                    self.assertEqual(self.main(case, 'token'), (0, 'synthetic-access\n', ''))
                self.assertFalse(path.exists())

    def test_keychain_is_authoritative_even_when_legacy_is_corrupt(self):
        for case in self.cases:
            with self.subTest(helper=case.name):
                path = self.legacy(case, b'secret invalid JSON')
                FakeKeychain(case.directory).write(json.dumps(case.value).encode())
                with mock.patch.object(FakeKeychain, 'write', side_effect=AssertionError('No migration over Keychain')):
                    self.assertEqual(self.main(case, 'token'), (0, 'synthetic-access\n', ''))
                self.assertFalse(path.exists())

    def test_corrupt_or_oversized_keychain_does_not_fall_back_to_plaintext(self):
        for case in self.cases:
            path = self.legacy(case)
            for raw in [b'secret invalid JSON', b'[]', b'x' * (case.auth.MAX_JSON_BYTES + 1)]:
                with self.subTest(helper=case.name, length=len(raw)), mock.patch.object(FakeKeychain, 'read', return_value=raw):
                    code, stdout, stderr = self.main(case, 'token')
                self.assertEqual((code, stdout), (1, ''))
                self.assertNotIn('secret invalid', stderr)
                self.assertTrue(path.exists())

    def test_failed_cleanup_retries_without_overwriting_keychain(self):
        for case in self.cases:
            with self.subTest(helper=case.name):
                path = self.legacy(case)
                remove = 'remove_legacy_tokens' if case.name == 'datadog' else 'remove_legacy_grant'
                with mock.patch.object(case.auth, remove, side_effect=OSError('private cleanup error')):
                    code, stdout, stderr = self.main(case, 'token')
                self.assertEqual((code, stdout), (1, ''))
                self.assertNotIn('private cleanup error', stderr)
                self.assertTrue(path.exists())
                with mock.patch.object(FakeKeychain, 'write', side_effect=AssertionError('No repeat migration')):
                    self.assertEqual(self.main(case, 'token'), (0, 'synthetic-access\n', ''))
                self.assertFalse(path.exists())

    def test_migration_and_logout_remove_only_recognized_crash_leftovers(self):
        for case in self.cases:
            for command in ['status', 'logout']:
                with self.subTest(helper=case.name, command=command):
                    path = self.legacy(case)
                    leftover = case.directory / (case.filename + '.abc12_34.tmp')
                    leftover.write_bytes(json.dumps(case.value).encode())
                    leftover.chmod(0o600)
                    unrelated = case.directory / (case.filename + '.backup.tmp')
                    unrelated.write_text('unrelated')
                    self.assertEqual(self.main(case, command)[0], 0)
                    self.assertFalse(path.exists())
                    self.assertFalse(leftover.exists())
                    self.assertEqual(unrelated.read_text(), 'unrelated')

    def test_orphaned_first_save_requires_explicit_logout_instead_of_silent_success(self):
        for case in self.cases:
            with self.subTest(helper=case.name):
                path = self.legacy(case)
                leftover = case.directory / (case.filename + '.abc12_34.tmp')
                path.rename(leftover)
                for command in ['status', 'token']:
                    code, stdout, stderr = self.main(case, command)
                    self.assertEqual((code, stdout), (1, ''))
                    self.assertIn('logout', stderr)
                    self.assertNotIn('synthetic', stderr)
                    self.assertTrue(leftover.exists())
                    self.assertIsNone(FakeKeychain(case.directory).read())
                case.auth.request_json.assert_not_called()
                self.assertEqual(self.main(case, 'logout')[0], 0)
                self.assertFalse(leftover.exists())
                code, stdout, stderr = self.main(case, 'status')
                self.assertEqual(code, 0, stderr)
                self.assertEqual(json.loads(stdout)['state'], 'not_signed_in')

    def test_failed_migration_keeps_crash_leftovers(self):
        for case in self.cases:
            with self.subTest(helper=case.name):
                path = self.legacy(case)
                leftover = case.directory / (case.filename + '.abc12_34.tmp')
                leftover.write_bytes(path.read_bytes())
                leftover.chmod(0o600)
                with mock.patch.object(FakeKeychain, 'write', side_effect=keychain.AuthError('Keychain unavailable')):
                    self.assertEqual(self.main(case, 'status')[0], 1)
                self.assertTrue(path.exists())
                self.assertTrue(leftover.exists())

    def test_crash_cleanup_does_not_follow_symlinks_or_delete_hardlinked_files(self):
        target = self.root / 'outside'
        target.write_text('leave untouched')
        target.chmod(0o600)
        for case in self.cases:
            with self.subTest(helper=case.name):
                path = self.legacy(case)
                leftover = case.directory / (case.filename + '.abc12_34.tmp')
                leftover.symlink_to(target)
                self.assertEqual(self.main(case, 'status')[0], 1)
                self.assertTrue(leftover.is_symlink())
                leftover.unlink()
                os.link(target, leftover)
                self.assertEqual(self.main(case, 'status')[0], 1)
                self.assertTrue(path.exists())
                self.assertEqual(target.read_text(), 'leave untouched')
                leftover.unlink()

    def test_logout_does_not_migrate_or_resurrect_legacy(self):
        for case in self.cases:
            with self.subTest(helper=case.name):
                path = self.legacy(case)
                with mock.patch.object(FakeKeychain, 'write', side_effect=AssertionError('Logout must not migrate')):
                    self.assertEqual(self.main(case, 'logout')[0], 0)
                self.assertFalse(path.exists())
                self.assertIsNone(case.read(case.directory))
                self.legacy(case)
                FakeKeychain(case.directory).write(json.dumps(case.value).encode())
                with mock.patch.object(FakeKeychain, 'delete', side_effect=keychain.AuthError('Keychain unavailable')):
                    self.assertEqual(self.main(case, 'logout')[0], 1)
                self.assertFalse(path.exists())
                self.assertEqual(case.read(case.directory), case.value)
                self.assertEqual(self.main(case, 'logout')[0], 0)
                self.assertIsNone(case.read(case.directory))

    def test_unsupported_host_never_reads_or_deletes_plaintext(self):
        for case in self.cases:
            path = self.legacy(case)
            with mock.patch.object(case.auth, 'Keychain', case.native), mock.patch.object(sys, 'platform', 'linux'):
                for command in ['token', 'status', 'login', 'logout']:
                    with self.subTest(helper=case.name, command=command):
                        code, stdout, stderr = self.main(case, command)
                        self.assertEqual((code, stdout), (1, ''))
                        self.assertIn('host credential proxy', stderr)
                        self.assertTrue(path.exists())
            case.auth.request_json.assert_not_called()
            case.auth.webbrowser.open.assert_not_called()

    def test_unavailable_keychain_stops_login_before_browser_or_network(self):
        for case in self.cases:
            with self.subTest(helper=case.name), mock.patch.object(FakeKeychain, 'read', side_effect=keychain.AuthError('Keychain unavailable')):
                self.assertEqual(self.main(case, 'login')[0], 1)
            case.auth.request_json.assert_not_called()
            case.auth.webbrowser.open.assert_not_called()

    def test_new_secure_writes_and_size_rejection_never_create_plaintext(self):
        for case in self.cases:
            with self.subTest(helper=case.name), case.auth.locked(case.directory):
                case.write(case.directory, case.value)
                self.assertEqual(case.read(case.directory), case.value)
                oversized = {**case.value, 'extra': 'x' * case.auth.MAX_JSON_BYTES}
                with self.assertRaises(keychain.AuthError):
                    case.write(case.directory, oversized)
                self.assertEqual(case.read(case.directory), case.value)
                self.assertFalse((case.directory / case.filename).exists())
                self.assertEqual(list(case.directory.glob('*.tmp')), [])

    def test_native_keychain_requires_an_explicit_service_namespace(self):
        with mock.patch.object(sys, 'platform', 'darwin'), self.assertRaises(keychain.AuthError):
            keychain.Keychain(self.root)

    def test_service_namespaces_and_resource_directories_remain_distinct(self):
        slack = load_auth(BIN / 'slack-mcp-auth', fake_keychain=False)
        services = {slack.Keychain.SERVICE}
        for case in self.cases:
            self.assertTrue(issubclass(case.native, keychain.Keychain))
            services.add(case.native.SERVICE)
            other = 'mcp.us3.datadoghq.com' if case.name == 'datadog' else 'https://other.example.invalid/mcp'
            other_directory = case.auth.store_directory(other)
            self.assertNotEqual(other_directory, case.directory)
            path = self.legacy(case)
            with case.auth.locked(other_directory):
                self.assertIsNone(case.read(other_directory))
            self.assertTrue(path.exists())
            self.assertIsNone(FakeKeychain(case.directory).read())
        self.assertEqual(services, {b'pi.slack-mcp', b'pi.datadog-mcp', b'pi.google-workspace-mcp'})


if __name__ == '__main__':
    unittest.main()
