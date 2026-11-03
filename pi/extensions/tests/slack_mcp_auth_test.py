import base64
import contextlib
import hashlib
import http.client
import importlib.machinery
import io
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock
import urllib.error
import urllib.parse
import urllib.request

from slack_auth_fixture import FakeKeychain

SCRIPT = Path(__file__).resolve().parents[1] / 'bin/slack-mcp-auth'
auth = types.ModuleType('slack_mcp_auth')
importlib.machinery.SourceFileLoader(auth.__name__, str(SCRIPT)).exec_module(auth)
REQUEST_JSON = auth.request_json
KEYCHAIN = auth.Keychain

# No worker inherits the real HOME/XDG or performs network requests.
WORKER = '''
import pathlib, sys, time
from slack_auth_fixture import load_auth
module = load_auth(sys.argv[1])
def refresh(url, body=None):
    assert url == module.TOKEN_URL
    assert body['refresh_token'] == 'synthetic-refresh'
    print('refreshing', file=sys.stderr, flush=True)
    with pathlib.Path(sys.argv[2]).open('a') as counter:
        counter.write('refresh\\n')
    time.sleep(0.3)
    return {'ok': True, 'token_type': 'user', 'access_token': 'new-access', 'refresh_token': 'new-refresh', 'expires_in': 43200}
module.request_json = refresh
sys.exit(module.main(['token']))
'''


class SlackAuthTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='slack-auth-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.env = {'HOME': str(self.root / 'home'), 'XDG_STATE_HOME': str(self.root / 'state'),
                    'PATH': os.environ.get('PATH', ''), 'PYTHONDONTWRITEBYTECODE': '1',
                    'PYTHONPATH': str(SCRIPT.parent.parent / 'tests')}
        mock.patch.dict(os.environ, self.env, clear=True).start()
        self.keychain = mock.patch.object(auth, 'Keychain', side_effect=FakeKeychain).start()
        mock.patch.object(auth.ctypes, 'CDLL', side_effect=AssertionError('Tests must not access the host Keychain')).start()
        self.http = mock.patch.object(auth, 'request_json', side_effect=AssertionError('Unexpected HTTP request')).start()
        self.browser = mock.patch.object(auth.webbrowser, 'open', side_effect=AssertionError('Unexpected browser launch')).start()
        self.addCleanup(mock.patch.stopall)
        for signum in (signal.SIGALRM, signal.SIGTERM):
            self.addCleanup(signal.signal, signum, signal.getsignal(signum))
        self.directory = auth.store_directory()
        self.tokens = {'clientId': auth.CLIENT_ID, 'accessToken': 'synthetic-access', 'refreshToken': 'synthetic-refresh',
                       'expiresAt': time.time() * 1000 + 43_200_000, 'scope': 'search:read.public,chat:write'}
        self.response = {'ok': True, 'token_type': 'user', 'access_token': 'new-access',
                         'refresh_token': 'new-refresh', 'expires_in': 43200}
        self.metadata = {'issuer': auth.RESOURCE, 'authorization_endpoint': auth.AUTHORIZE_URL,
                         'token_endpoint': auth.TOKEN_URL, 'code_challenge_methods_supported': ['S256'],
                         'scopes_supported': ['search:read.public', 'chat:write']}

    def seed(self, updates=None):
        with auth.locked(self.directory):
            auth.write_tokens(self.directory, {**self.tokens, **(updates or {})})

    def seed_legacy(self, raw=None):
        with auth.locked(self.directory):
            path = self.directory / 'tokens.json'
            with os.fdopen(auth.private_open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC), 'wb') as file:
                file.write(json.dumps(self.tokens).encode() if raw is None else raw)
        return path

    def main(self, *args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = auth.main(list(args))
        return code, stdout.getvalue(), stderr.getvalue()

    def cli(self, *args):
        return subprocess.run([sys.executable, '-B', '-c',
                               'import sys; from slack_auth_fixture import load_auth; sys.exit(load_auth(sys.argv[1]).main(sys.argv[2:]))',
                               str(SCRIPT), *args], env=self.env,
                              cwd=self.root, capture_output=True, text=True, timeout=10)

    def worker(self):
        process = subprocess.Popen([sys.executable, '-B', '-c', WORKER, str(SCRIPT), str(self.root / 'refreshes')],
                                   env=self.env, cwd=self.root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.cleanup_process, process)
        return process

    @staticmethod
    def cleanup_process(process):
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=5)

    def test_state_is_pi_owned_with_absolute_xdg_or_home_fallback(self):
        for xdg in ['', 'relative', str(self.root / 'elsewhere')]:
            with self.subTest(xdg=xdg), mock.patch.dict(os.environ, {'XDG_STATE_HOME': xdg}):
                expected = Path(xdg) if xdg and Path(xdg).is_absolute() else Path(self.env['HOME']) / '.local/state'
                self.assertEqual(auth.store_directory(), expected / 'pi/slack-mcp')

    def test_fresh_token_stdout_is_only_token_and_never_reads_claude_or_starts_subprocess(self):
        self.seed()
        result = self.cli('token')
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, 'synthetic-access\n', ''))
        with mock.patch.object(subprocess, 'Popen', side_effect=AssertionError('No external auth process')):
            self.assertEqual(self.main('token'), (0, 'synthetic-access\n', ''))
        self.assertFalse(Path(self.env['HOME']).exists())
        self.http.assert_not_called()
        self.browser.assert_not_called()

    def test_status_is_offline_nonsecret_and_does_not_claim_refresh_validity(self):
        self.seed()
        code, stdout, stderr = self.main('status')
        self.assertEqual(code, 0)
        value = json.loads(stdout)
        self.assertEqual(value['state'], 'access_token_valid')
        self.assertEqual(value['refresh_validity'], 'not_checked')
        self.assertTrue(value['refresh_token_present'])
        self.assertNotIn('synthetic', stdout + stderr)
        self.seed({'expiresAt': 1})
        self.assertEqual(json.loads(self.main('status')[1])['state'], 'expired')
        self.http.assert_not_called()

    def test_missing_grant_fails_without_implicit_login(self):
        code, stdout, stderr = self.main('token')
        self.assertEqual((code, stdout), (1, ''))
        self.assertIn('login', stderr)
        self.assertEqual(json.loads(self.main('status')[1]), {'state': 'not_signed_in'})
        self.http.assert_not_called()
        self.browser.assert_not_called()

    def test_refresh_uses_fixed_user_endpoint_without_client_secret_or_discovery(self):
        self.seed({'expiresAt': 1})
        self.http.side_effect = None
        self.http.return_value = self.response
        self.assertEqual(self.main('token'), (0, 'new-access\n', ''))
        self.http.assert_called_once_with(auth.TOKEN_URL, {
            'grant_type': 'refresh_token', 'refresh_token': 'synthetic-refresh', 'client_id': auth.CLIENT_ID,
        })
        saved = auth.read_tokens(self.directory)
        self.assertEqual(saved['refreshToken'], 'new-refresh')
        self.assertEqual(saved['scope'], self.tokens['scope'])
        self.assertGreater(saved['expiresAt'], self.tokens['expiresAt'] - 1000)
        self.browser.assert_not_called()

    def test_refresh_boundary_and_forced_refresh(self):
        self.http.side_effect = None
        self.http.return_value = self.response
        for remaining, forced, expected in [(300_001, False, 0), (300_000, False, 1), (43_200_000, True, 1)]:
            with self.subTest(remaining=remaining, forced=forced), mock.patch.object(auth.time, 'time', return_value=1000):
                self.seed({'expiresAt': 1_000_000 + remaining})
                self.http.reset_mock()
                self.assertEqual(self.main('token', *(['--refresh'] if forced else []))[0], 0)
                self.assertEqual(self.http.call_count, expected)

    def test_refresh_failure_never_retries_or_changes_saved_grant(self):
        self.seed({'expiresAt': 1})
        before = FakeKeychain(self.directory).read()
        self.http.side_effect = auth.AuthError('OAuth rejected.')
        code, stdout, stderr = self.main('token')
        self.assertEqual((code, stdout), (1, ''))
        self.assertEqual(FakeKeychain(self.directory).read(), before)
        self.assertNotIn('synthetic', stderr)
        self.http.assert_called_once()

    def test_failed_persistence_never_releases_refreshed_access_token(self):
        self.seed({'expiresAt': 1})
        self.http.side_effect = None
        self.http.return_value = self.response
        with mock.patch.object(auth, 'write_tokens', side_effect=OSError('new-refresh')):
            code, stdout, stderr = self.main('token')
        self.assertEqual((code, stdout), (1, ''))
        self.assertNotIn('new-', stderr)
        self.assertEqual(auth.read_tokens(self.directory)['refreshToken'], 'synthetic-refresh')

    def test_rotated_token_requires_new_refresh_token_expiry_and_user_type(self):
        for updates in [{'refresh_token': None}, {'refresh_token': ''}, {'access_token': ''}, {'access_token': 'secret\r\n'},
                        {'access_token': ' token'}, {'access_token': 'ünicode'}, {'ok': False}, {'ok': 1},
                        {'token_type': 'bot'}, {'token_type': None}, {'expires_in': None}, {'expires_in': False},
                        {'expires_in': -1}, {'expires_in': float('inf')}, {'expires_in': 10**308},
                        {'expires_in': 10**400}, {'error': 'secret-provider-response'}]:
            with self.subTest(updates=updates), self.assertRaises(auth.AuthError):
                auth.normalize_tokens({**self.response, **updates}, self.tokens)
        for omitted in ['refresh_token', 'expires_in', 'ok', 'token_type']:
            response = {k: v for k, v in self.response.items() if k != omitted}
            with self.subTest(omitted=omitted), self.assertRaises(auth.AuthError):
                auth.normalize_tokens(response, self.tokens)

    def test_user_response_preserves_only_needed_fields_and_handles_nested_scope(self):
        response = {**self.response, 'id_token': 'secret-id-token', 'team': {'id': 'synthetic-team'},
                    'authed_user': {'id': 'synthetic-user', 'scope': 'chat:write'}}
        result = auth.normalize_tokens(response)
        self.assertEqual(set(result), {'clientId', 'accessToken', 'refreshToken', 'expiresAt', 'scope'})
        self.assertEqual(result['scope'], 'chat:write')
        self.assertEqual(auth.normalize_tokens({**response, 'scope': 'files:read'})['scope'], 'files:read')
        for token_type in ['user', 'bearer', 'Bearer']:
            self.assertEqual(auth.normalize_tokens({**self.response, 'token_type': token_type})['accessToken'], 'new-access')

    def test_saved_tokens_reject_wrong_client_malformed_credentials_and_expiry(self):
        for updates in [{'clientId': 'other-app'}, {'refreshToken': None}, {'accessToken': 'a b'},
                        {'expiresAt': True}, {'expiresAt': float('inf')}, {'expiresAt': 10**400}, {'scope': 'bad\n'}]:
            with self.subTest(updates=updates), self.assertRaises(auth.AuthError):
                auth.validate_tokens({**self.tokens, **updates})

    def test_private_storage_and_symlink_hardlink_protection(self):
        self.seed_legacy()
        for path in [self.directory.parent, self.directory]:
            self.assertEqual(path.stat().st_mode & 0o777, 0o700)
        for path in self.directory.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        path = self.directory / 'tokens.json'
        target = self.root / 'outside'
        target.write_text('leave untouched')
        target.chmod(0o600)
        path.unlink()
        path.symlink_to(target)
        self.assertEqual(self.main('token')[0], 1)
        path.unlink()
        os.link(target, path)
        self.assertEqual(self.main('token')[0], 1)
        self.assertEqual(target.read_text(), 'leave untouched')

    def test_symlinked_directory_or_lock_is_rejected(self):
        self.directory.parent.mkdir(parents=True)
        target = self.root / 'outside'
        target.mkdir()
        self.directory.symlink_to(target, target_is_directory=True)
        self.assertEqual(self.main('status')[0], 1)
        self.assertEqual(list(target.iterdir()), [])
        self.directory.unlink()
        self.seed()
        (self.directory / '.lock').unlink()
        (self.directory / '.lock').symlink_to(self.directory / 'tokens.json')
        self.assertEqual(self.main('status')[0], 1)

    def test_keychain_write_failure_leaves_previous_grant(self):
        self.seed()
        with mock.patch.object(FakeKeychain, 'write', side_effect=auth.AuthError('Keychain unavailable')):
            with self.assertRaises(auth.AuthError):
                auth.write_tokens(self.directory, {**self.tokens, 'accessToken': 'new'})
        self.assertEqual(auth.read_tokens(self.directory), self.tokens)
        self.assertFalse((self.directory / 'tokens.json').exists())

    def test_malformed_oversized_and_public_files_fail_silently(self):
        path = self.seed_legacy()
        for raw in ['secret invalid json', '[]', 'x' * (auth.MAX_JSON_BYTES + 1)]:
            path.write_text(raw)
            code, stdout, stderr = self.main('token')
            self.assertEqual((code, stdout), (1, ''))
            self.assertNotIn('secret', stderr)
        self.seed_legacy()
        path.chmod(0o644)
        self.assertEqual(self.main('token')[0], 1)

    def test_status_migrates_legacy_credentials_without_network_or_secret_output(self):
        path = self.seed_legacy()
        code, stdout, stderr = self.main('status')
        self.assertEqual(code, 0, stderr)
        self.assertNotIn('synthetic', stdout + stderr)
        self.assertFalse(path.exists())
        self.assertEqual(auth.read_tokens(self.directory), self.tokens)
        self.http.assert_not_called()

    def test_migration_and_logout_remove_crash_leftovers_but_not_unrelated_files(self):
        for command in ['status', 'logout']:
            with self.subTest(command=command):
                self.seed_legacy()
                leftover = self.directory / 'tokens.abc12_34.tmp'
                leftover.write_bytes(json.dumps(self.tokens).encode())
                leftover.chmod(0o600)
                unrelated = self.directory / 'tokens.backup.tmp'
                unrelated.write_text('unrelated')
                code, stdout, stderr = self.main(command)
                self.assertEqual(code, 0, stderr)
                self.assertFalse(leftover.exists())
                self.assertFalse((self.directory / 'tokens.json').exists())
                self.assertEqual(unrelated.read_text(), 'unrelated')
                self.assertNotIn('synthetic', stdout + stderr)

    def test_leftover_cleanup_does_not_follow_symlinks_or_remove_hardlinked_files(self):
        self.seed_legacy()
        target = self.root / 'outside'
        target.write_text('leave untouched')
        target.chmod(0o600)
        leftover = self.directory / 'tokens.abc12_34.tmp'
        leftover.symlink_to(target)
        self.assertEqual(self.main('status')[0], 1)
        self.assertTrue(leftover.is_symlink())
        leftover.unlink()
        os.link(target, leftover)
        self.assertEqual(self.main('status')[0], 1)
        self.assertEqual(target.read_text(), 'leave untouched')
        self.assertTrue((self.directory / 'tokens.json').exists())

    def test_failed_migration_keeps_crash_leftovers(self):
        self.seed_legacy()
        leftover = self.directory / 'tokens.abc12_34.tmp'
        leftover.write_bytes(json.dumps(self.tokens).encode())
        leftover.chmod(0o600)
        with mock.patch.object(FakeKeychain, 'write', side_effect=auth.AuthError('Keychain unavailable')):
            self.assertEqual(self.main('status')[0], 1)
        self.assertTrue(leftover.exists())
        self.assertTrue((self.directory / 'tokens.json').exists())

    def test_failed_migration_preserves_plaintext_and_does_not_release_token(self):
        path = self.seed_legacy()
        before = path.read_bytes()
        for method in ['read', 'write']:
            with self.subTest(method=method), mock.patch.object(FakeKeychain, method, side_effect=auth.AuthError('Keychain unavailable')):
                code, stdout, stderr = self.main('token')
                self.assertEqual((code, stdout), (1, ''))
                self.assertNotIn('synthetic', stderr)
            self.assertEqual(path.read_bytes(), before)
        self.http.assert_not_called()

    def test_migration_requires_readback_before_removing_plaintext(self):
        path = self.seed_legacy()
        with mock.patch.object(FakeKeychain, 'read', return_value=None):
            code, stdout, stderr = self.main('token')
        self.assertEqual((code, stdout), (1, ''))
        self.assertIn('verification failed', stderr)
        self.assertTrue(path.exists())
        self.assertEqual(self.main('token'), (0, 'synthetic-access\n', ''))
        self.assertFalse(path.exists())

    def test_existing_keychain_wins_over_stale_legacy_grant(self):
        self.seed({'accessToken': 'current-access', 'refreshToken': 'current-refresh'})
        path = self.seed_legacy()
        self.assertEqual(self.main('token'), (0, 'current-access\n', ''))
        self.assertFalse(path.exists())
        self.http.assert_not_called()

    def test_failed_legacy_removal_retries_without_overwriting_keychain(self):
        path = self.seed_legacy()
        with mock.patch.object(auth, 'remove_legacy_tokens', side_effect=OSError('failure')):
            self.assertEqual(self.main('token')[0], 1)
        self.assertTrue(path.exists())
        with mock.patch.object(FakeKeychain, 'write', side_effect=AssertionError('Must not overwrite saved grant')):
            self.assertEqual(self.main('token'), (0, 'synthetic-access\n', ''))
        self.assertFalse(path.exists())

    def test_corrupt_keychain_does_not_fall_back_to_legacy(self):
        path = self.seed_legacy()
        for raw in [b'secret invalid', b'[]', b'x' * (auth.MAX_JSON_BYTES + 1)]:
            with self.subTest(raw=raw[:20]), mock.patch.object(FakeKeychain, 'read', return_value=raw):
                code, stdout, stderr = self.main('token')
                self.assertEqual((code, stdout), (1, ''))
                self.assertNotIn('secret invalid', stderr)
                self.assertTrue(path.exists())
        self.http.assert_not_called()

    def test_fresh_storage_and_refresh_never_create_plaintext(self):
        self.seed({'expiresAt': 1})
        self.http.side_effect = None
        self.http.return_value = self.response
        self.assertEqual(self.main('token')[0], 0)
        self.assertFalse((self.directory / 'tokens.json').exists())
        self.assertEqual(list(self.directory.glob('tokens.*')), [])

    def test_logout_removes_both_stores_and_does_not_migrate(self):
        self.seed()
        self.seed_legacy()
        with mock.patch.object(FakeKeychain, 'write', side_effect=AssertionError('Logout must not migrate')):
            self.assertEqual(self.main('logout')[0], 0)
        self.assertFalse((self.directory / 'tokens.json').exists())
        self.assertIsNone(FakeKeychain(self.directory).read())

    def test_interrupted_logout_cannot_resurrect_legacy_grant(self):
        self.seed_legacy()
        with mock.patch.object(FakeKeychain, 'delete', side_effect=auth.AuthError('Keychain unavailable')):
            self.assertEqual(self.main('logout')[0], 1)
        self.assertFalse((self.directory / 'tokens.json').exists())
        self.assertEqual(json.loads(self.main('status')[1])['state'], 'not_signed_in')

    def test_unsupported_host_fails_closed_without_touching_legacy_credentials(self):
        path = self.seed_legacy()
        self.keychain.side_effect = KEYCHAIN
        with mock.patch.object(auth.sys, 'platform', 'linux'):
            for command in ['token', 'status', 'login', 'logout']:
                code, stdout, stderr = self.main(command)
                self.assertEqual((code, stdout), (1, ''))
                self.assertIn('host credential proxy', stderr)
                self.assertTrue(path.exists())
        self.http.assert_not_called()
        self.browser.assert_not_called()

    def test_keychain_failure_prevents_login_consent(self):
        with mock.patch.object(FakeKeychain, 'read', side_effect=auth.AuthError('Keychain unavailable')):
            self.assertEqual(self.main('login')[0], 1)
        self.http.assert_not_called()
        self.browser.assert_not_called()

    def test_concurrent_migration_and_refresh_use_one_grant(self):
        self.tokens['expiresAt'] = 1
        path = self.seed_legacy()
        for worker in [self.worker(), self.worker()]:
            stdout, stderr = worker.communicate(timeout=10)
            self.assertEqual((worker.returncode, stdout), (0, 'new-access\n'), stderr)
        self.assertFalse(path.exists())
        self.assertEqual((self.root / 'refreshes').read_text(), 'refresh\n')

    def test_concurrent_helpers_refresh_once_and_reread_rotated_grant(self):
        self.seed({'expiresAt': 1})
        for worker in [self.worker(), self.worker()]:
            stdout, stderr = worker.communicate(timeout=10)
            self.assertEqual((worker.returncode, stdout), (0, 'new-access\n'), stderr)
        self.assertEqual((self.root / 'refreshes').read_text(), 'refresh\n')
        self.assertEqual(auth.read_tokens(self.directory)['refreshToken'], 'new-refresh')

    def test_logout_waits_for_refresh_and_cannot_be_resurrected(self):
        self.seed({'expiresAt': 1})
        worker = self.worker()
        self.assertEqual(worker.stderr.readline(), 'refreshing\n')
        result = self.cli('logout')
        worker.communicate(timeout=10)
        self.assertEqual((result.returncode, worker.returncode), (0, 0))
        self.assertIsNone(auth.read_tokens(self.directory))

    def test_lock_wait_is_bounded_and_death_releases_lock(self):
        self.seed()
        process = subprocess.Popen([sys.executable, '-c',
            'import fcntl,sys,time; f=open(sys.argv[1],"r+"); fcntl.flock(f,fcntl.LOCK_EX); print("locked",flush=True); time.sleep(30)',
            str(self.directory / '.lock')], env=self.env, stdout=subprocess.PIPE, text=True)
        self.addCleanup(self.cleanup_process, process)
        self.assertEqual(process.stdout.readline(), 'locked\n')
        with mock.patch.object(auth, 'LOCK_TIMEOUT', 0.05):
            code, stdout, stderr = self.main('token')
        self.assertEqual((code, stdout), (1, ''))
        self.assertIn('busy', stderr)
        process.kill()
        process.wait(timeout=5)
        self.assertEqual(self.cli('token').stdout, 'synthetic-access\n')

    def test_logout_is_idempotent_and_does_not_revoke_slack_installation(self):
        self.seed()
        for _ in range(2):
            code, stdout, stderr = self.main('logout')
            self.assertEqual(code, 0, stderr)
            self.assertIn('not revoked', stdout)
        self.assertIsNone(auth.read_tokens(self.directory))
        self.http.assert_not_called()

    def test_http_boundary_blocks_proxies_redirects_other_endpoints_and_raw_errors(self):
        with mock.patch.object(urllib.request, 'build_opener') as factory:
            response = factory.return_value.open.return_value.__enter__.return_value
            response.read.return_value = b'{"ok":true}'
            self.assertEqual(REQUEST_JSON(auth.TOKEN_URL, {'refresh_token': 'synthetic'}), {'ok': True})
            proxy, redirects = factory.call_args.args
            self.assertEqual(proxy.proxies, {})
            self.assertIsNone(redirects.redirect_request(None, None, 302, '', {}, 'https://other.invalid'))
            request = factory.return_value.open.call_args.args[0]
            self.assertEqual(request.data, b'refresh_token=synthetic')
            self.assertEqual(factory.return_value.open.call_args.kwargs['timeout'], auth.HTTP_TIMEOUT)
            response.read.assert_called_once_with(auth.MAX_JSON_BYTES + 1)
            for url in ['http://slack.com/api/oauth.v2.user.access', 'https://other.invalid', auth.TOKEN_URL + '?extra=1']:
                before = factory.call_count
                with self.assertRaises(auth.AuthError):
                    REQUEST_JSON(url)
                self.assertEqual(factory.call_count, before)
            for raw in [b'secret invalid', b'[]', b'{"error":"secret"}', b'{"ok":false}', b'{"ok":1}', b'x' * (auth.MAX_JSON_BYTES + 1)]:
                response.read.return_value = raw
                with self.assertRaises(auth.AuthError) as caught:
                    REQUEST_JSON(auth.TOKEN_URL)
                self.assertNotIn('secret', str(caught.exception))
            for error in [TimeoutError('secret'), http.client.BadStatusLine('secret'), http.client.IncompleteRead(b'secret', 100),
                          urllib.error.HTTPError(auth.TOKEN_URL, 401, 'secret', {}, io.BytesIO(b'secret'))]:
                factory.return_value.open.side_effect = error
                self.http.side_effect = REQUEST_JSON
                self.seed({'expiresAt': 1})
                before = factory.return_value.open.call_count
                code, stdout, stderr = self.main('token')
                self.assertEqual((code, stdout), (1, ''))
                self.assertNotIn('secret', stderr)
                self.assertNotIn('Traceback', stderr)
                self.assertEqual(factory.return_value.open.call_count, before + 1)

    def test_login_metadata_requires_expected_endpoints_pkce_and_valid_scopes(self):
        self.http.side_effect = None
        self.http.return_value = self.metadata
        self.assertEqual(auth.login_scopes(), 'search:read.public chat:write')
        self.http.assert_called_once_with(auth.METADATA_URL)
        for updates in [{'issuer': 'https://other.invalid'}, {'authorization_endpoint': 'https://other.invalid'},
                        {'token_endpoint': 'https://other.invalid'}, {'code_challenge_methods_supported': None},
                        {'code_challenge_methods_supported': 'S256'}, {'code_challenge_methods_supported': ['plain']},
                        {'scopes_supported': []}, {'scopes_supported': ['bad scope']}, {'scopes_supported': [None]}]:
            self.http.return_value = {**self.metadata, **updates}
            with self.subTest(updates=updates), self.assertRaises(auth.AuthError):
                auth.login_scopes()

    def prepare_login(self, failure=False):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        mock.patch.object(auth, 'REDIRECT_URI', f'http://localhost:{port}/callback').start()
        callbacks, threads, errors = [], [], []
        def open_browser(url):
            self.assertEqual(url.split('?')[0], auth.AUTHORIZE_URL)
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
            callbacks.append(query)
            def callback():
                try:
                    requests = [
                        ('/callback', [('state', 'wrong'), ('code', 'ignored')]),
                        ('/wrong', [('state', query['state'][0]), ('code', 'ignored')]),
                        ('/callback', [('state', query['state'][0]), ('state', ''), ('code', 'ignored')]),
                        ('/callback', [('state', query['state'][0]), ('error', '')] if failure else [('state', query['state'][0]), ('code', 'synthetic-code')]),
                    ]
                    for path, params in requests:
                        url = f'http://127.0.0.1:{port}' + path + '?' + urllib.parse.urlencode(params)
                        try:
                            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url, timeout=3) as response:
                                response.read()
                        except urllib.error.HTTPError as error:
                            self.assertEqual(error.code, 400)
                            error.close()
                except Exception as error:
                    errors.append(error)
            thread = threading.Thread(target=callback)
            threads.append(thread)
            thread.start()
            return True
        self.browser.side_effect = open_browser
        self.http.side_effect = lambda url, body=None: self.metadata if url == auth.METADATA_URL else self.response
        def join_threads():
            for thread in threads:
                thread.join(timeout=5)
                self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
        self.addCleanup(join_threads)
        return callbacks

    def test_login_uses_public_registration_fixed_callback_pkce_and_private_store(self):
        self.assertEqual(auth.REDIRECT_URI, 'http://localhost:3118/callback')
        callbacks = self.prepare_login()
        self.seed()
        code, stdout, stderr = self.main('login')
        self.assertEqual(code, 0, stderr)
        self.assertIn('Signed in to Slack', stdout)
        self.assertNotIn('new-access', stdout + stderr)
        self.assertNotIn('new-refresh', stdout + stderr)
        self.assertNotIn('synthetic-code', stdout + stderr)
        self.assertEqual(self.http.call_count, 2)
        url, body = self.http.call_args.args
        self.assertEqual(url, auth.TOKEN_URL)
        self.assertEqual(body['code'], 'synthetic-code')
        self.assertEqual(body['client_id'], auth.CLIENT_ID)
        self.assertEqual(body['redirect_uri'], auth.REDIRECT_URI)
        self.assertNotIn('client_secret', body)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(body['code_verifier'].encode()).digest()).rstrip(b'=').decode()
        self.assertEqual(callbacks[0]['code_challenge'], [challenge])
        self.assertEqual(callbacks[0]['code_challenge_method'], ['S256'])
        self.assertEqual(callbacks[0]['scope'], ['search:read.public chat:write'])
        self.assertEqual(callbacks[0]['resource'], [auth.RESOURCE])
        self.assertEqual(auth.read_tokens(self.directory)['refreshToken'], 'new-refresh')
        self.assertEqual({p.name for p in self.directory.iterdir()}, {'.lock', 'test-keychain'})
        self.assertFalse(Path(self.env['HOME']).exists())

    def test_denied_login_does_not_exchange_or_change_existing_grant(self):
        self.prepare_login(failure=True)
        self.seed()
        code, stdout, stderr = self.main('login')
        self.assertEqual((code, stdout), (1, ''))
        self.assertIn('denied', stderr)
        self.http.assert_called_once_with(auth.METADATA_URL)
        self.assertEqual(auth.read_tokens(self.directory), self.tokens)

    def test_login_timeout_browser_failure_and_exchange_failure_preserve_old_grant(self):
        self.prepare_login()
        self.seed()
        browser = self.browser.side_effect
        self.browser.side_effect = OSError('secret-browser-error')
        with mock.patch.object(auth, 'LOGIN_TIMEOUT', 0):
            code, stdout, stderr = self.main('login')
        self.assertEqual((code, stdout), (1, ''))
        self.assertIn('Open this URL', stderr)
        self.assertIn('timed out', stderr)
        self.assertNotIn('secret-browser-error', stderr)
        self.assertEqual(auth.read_tokens(self.directory), self.tokens)
        self.browser.side_effect = browser
        self.http.side_effect = [self.metadata, auth.AuthError('Exchange rejected')]
        self.assertEqual(self.main('login')[0], 1)
        self.assertEqual(auth.read_tokens(self.directory), self.tokens)

    def test_occupied_callback_port_does_not_open_browser_or_modify_store(self):
        self.seed()
        self.http.side_effect = None
        self.http.return_value = self.metadata
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            sock.listen()
            with mock.patch.object(auth, 'REDIRECT_URI', f'http://localhost:{sock.getsockname()[1]}/callback'):
                self.assertEqual(self.main('login')[0], 1)
        self.browser.assert_not_called()
        self.assertEqual(auth.read_tokens(self.directory), self.tokens)

    def test_cancellation_in_callback_is_not_swallowed_and_never_exchanges(self):
        self.prepare_login()
        self.seed()
        self.browser.side_effect = None
        for signum in [signal.SIGTERM, signal.SIGALRM]:
            self.http.reset_mock()
            request, peer = socket.socketpair()
            with request, peer, \
                 mock.patch.object(auth.CallbackServer, 'handle_request', auth.CallbackServer._handle_request_noblock), \
                 mock.patch.object(auth.CallbackServer, 'get_request', return_value=(request, ('127.0.0.1', 1))), \
                 mock.patch.object(auth.CallbackServer, 'finish_request', side_effect=lambda *_: auth.interrupt(signum, None)):
                code, stdout, stderr = self.main('login')
            self.assertEqual((code, stdout), (1, ''))
            self.assertIn('interrupted', stderr)
            self.assertNotIn('Traceback', stderr)
            self.http.assert_called_once_with(auth.METADATA_URL)
            self.assertEqual(auth.read_tokens(self.directory), self.tokens)

    def test_help_and_invalid_refresh_option_do_not_access_store(self):
        for args, expected in [(('--help',), 0), (('login', '--refresh'), 2)]:
            result = self.cli(*args)
            self.assertEqual(result.returncode, expected)
        self.assertFalse(self.directory.exists())


class KeychainBindingTest(unittest.TestCase):
    def setUp(self):
        self.security, self.core = mock.Mock(), mock.Mock()
        for name in ['SecKeychainSetUserInteractionAllowed', 'SecKeychainCopyDefault',
                     'SecKeychainAddGenericPassword', 'SecKeychainItemModifyAttributesAndData',
                     'SecKeychainItemDelete', 'SecKeychainItemFreeContent']:
            getattr(self.security, name).return_value = 0
        self.find = self.security.SecKeychainFindGenericPassword
        self.find.return_value = KEYCHAIN.NOT_FOUND
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(auth.sys, 'platform', 'darwin').start()
        self.loader = mock.patch.object(auth.ctypes, 'CDLL', side_effect=[self.security, self.core]).start()
        self.store = KEYCHAIN(Path('/synthetic/slack-mcp'))

    def found(self, raw=b'synthetic-data'):
        self.buffer = auth.ctypes.create_string_buffer(raw)
        def find(_keychain, service_length, service, account_length, account, length, data, item):
            self.assertEqual(service[:service_length], b'pi.slack-mcp')
            self.assertEqual(account[:account_length], self.store.account)
            if length is not None:
                auth.ctypes.cast(length, auth.ctypes.POINTER(auth.ctypes.c_uint32))[0] = len(raw)
            if data is not None:
                auth.ctypes.cast(data, auth.ctypes.POINTER(auth.ctypes.c_void_p))[0] = auth.ctypes.addressof(self.buffer)
            if item is not None:
                auth.ctypes.cast(item, auth.ctypes.POINTER(auth.ctypes.c_void_p))[0] = 123
            return 0
        self.find.side_effect = find

    def test_native_libraries_signatures_and_no_gui_prompts(self):
        self.assertEqual(self.loader.call_args_list, [
            mock.call('/System/Library/Frameworks/Security.framework/Security'),
            mock.call('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation'),
        ])
        self.security.SecKeychainSetUserInteractionAllowed.assert_called_once_with(False)
        self.assertEqual(self.find.restype, auth.ctypes.c_int32)
        self.assertEqual(len(self.find.argtypes), 8)
        self.assertEqual(self.store.account, hashlib.sha256(b'/synthetic/slack-mcp').hexdigest().encode())

    def test_missing_read_and_delete_are_not_errors(self):
        self.assertIsNone(self.store.read())
        self.store.delete()
        self.security.SecKeychainItemDelete.assert_not_called()
        self.assertEqual(self.core.CFRelease.call_count, 2)

    def test_read_copies_and_frees_native_memory(self):
        self.found()
        self.assertEqual(self.store.read(), b'synthetic-data')
        self.security.SecKeychainItemFreeContent.assert_called_once()
        self.core.CFRelease.assert_called_once()

    def test_oversized_native_secret_is_freed_without_copying(self):
        self.found(b'x' * (auth.MAX_JSON_BYTES + 1))
        with mock.patch.object(auth.ctypes, 'string_at', side_effect=AssertionError('Do not copy oversized data')):
            with self.assertRaises(auth.AuthError):
                self.store.read()
        self.security.SecKeychainItemFreeContent.assert_called_once()
        self.core.CFRelease.assert_called_once()

    def test_write_adds_missing_item_and_updates_existing_item_in_place(self):
        self.store.write(b'first')
        self.assertEqual(self.security.SecKeychainAddGenericPassword.call_args.args[5:7], (5, b'first'))
        self.found()
        self.store.write(b'second')
        self.assertEqual(self.security.SecKeychainItemModifyAttributesAndData.call_args.args[1:], (None, 6, b'second'))
        self.security.SecKeychainItemDelete.assert_not_called()
        self.assertEqual(self.core.CFRelease.call_count, 3)

    def test_delete_releases_item_and_keychain(self):
        self.found()
        self.store.delete()
        self.security.SecKeychainItemDelete.assert_called_once()
        self.assertEqual(self.core.CFRelease.call_count, 2)

    def test_access_errors_are_not_treated_as_absent_items(self):
        for operation in [self.store.read, lambda: self.store.write(b'synthetic'), self.store.delete]:
            for status in [-25293, -25308, -128]:
                self.find.return_value = status
                with self.subTest(status=status), self.assertRaises(auth.AuthError) as caught:
                    operation()
                self.assertIn(f'OSStatus {status}', str(caught.exception))
        self.security.SecKeychainAddGenericPassword.assert_not_called()
        self.security.SecKeychainItemModifyAttributesAndData.assert_not_called()
        self.security.SecKeychainItemDelete.assert_not_called()

    def test_failed_update_releases_references_without_delete_or_add(self):
        self.found()
        self.security.SecKeychainItemModifyAttributesAndData.return_value = -25293
        with self.assertRaises(auth.AuthError):
            self.store.write(b'synthetic')
        self.assertEqual(self.core.CFRelease.call_count, 2)
        self.security.SecKeychainItemDelete.assert_not_called()
        self.security.SecKeychainAddGenericPassword.assert_not_called()


if __name__ == '__main__':
    unittest.main()
