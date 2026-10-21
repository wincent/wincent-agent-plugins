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

SCRIPT = Path(__file__).resolve().parents[1] / 'bin/datadog-mcp-auth'
auth = types.ModuleType('datadog_mcp_auth')
importlib.machinery.SourceFileLoader(auth.__name__, str(SCRIPT)).exec_module(auth)
REQUEST_JSON = auth.request_json

# Workers patch the HTTP boundary before invoking any auth operation. All state
# and credentials are synthetic; subprocesses never inherit the real HOME/XDG.
WORKER = '''
import importlib.machinery, pathlib, sys, time, types
module = types.ModuleType('auth')
importlib.machinery.SourceFileLoader('auth', sys.argv[1]).exec_module(module)
def refresh(url, body=None, form=False):
    assert body['refresh_token'] == 'synthetic-refresh'
    print('refreshing', file=sys.stderr, flush=True)
    with pathlib.Path(sys.argv[2]).open('a') as counter:
        counter.write('refresh\\n')
    time.sleep(0.3)
    return {'access_token': 'synthetic-new-access', 'refresh_token': 'synthetic-new-refresh', 'expires_in': 3600}
module.request_json = refresh
sys.exit(module.main(['token']))
'''


class AuthTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='datadog-auth-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.env = {'HOME': str(self.root / 'home'), 'XDG_STATE_HOME': str(self.root / 'state'),
                    'PATH': os.environ.get('PATH', ''), 'PYTHONDONTWRITEBYTECODE': '1'}
        self.environment = mock.patch.dict(os.environ, self.env, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.http = mock.patch.object(auth, 'request_json', side_effect=AssertionError('Unexpected HTTP request')).start()
        self.browser = mock.patch.object(auth.webbrowser, 'open', side_effect=AssertionError('Unexpected browser launch')).start()
        self.addCleanup(mock.patch.stopall)
        for signum in (signal.SIGALRM, signal.SIGTERM):
            self.addCleanup(signal.signal, signum, signal.getsignal(signum))
        self.directory = auth.store_directory(auth.DEFAULT_DOMAIN)
        self.client = {
            'client_id': 'synthetic-client',
            'authorization_endpoint': 'https://auth.example.invalid/authorize',
            'token_endpoint': 'https://auth.example.invalid/token?tenant=example',
            'mcp_resource_uri': 'https://resource.example.invalid/mcp',
            'redirect_uris': ['http://localhost:19876/callback'],
        }
        self.tokens = {'accessToken': 'synthetic-access', 'refreshToken': 'synthetic-refresh',
                       'expiresAt': time.time() * 1000 + 3_600_000, 'scope': 'synthetic-scope'}

    def seed(self, tokens=None, client=None):
        with auth.locked(self.directory):
            auth.write_json(self.directory / 'client.json', self.client if client is None else client)
            auth.write_json(self.directory / 'tokens.json', self.tokens if tokens is None else tokens)

    def run_main(self, *args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = auth.main(list(args))
        return code, stdout.getvalue(), stderr.getvalue()

    def cli(self, *args):
        return subprocess.run([sys.executable, '-B', str(SCRIPT), *args], env=self.env,
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

    def test_state_root_matches_legacy_absolute_xdg_and_home_fallback(self):
        for xdg in ['', 'relative', str(self.root / 'elsewhere')]:
            with self.subTest(xdg=xdg), mock.patch.dict(os.environ, {'XDG_STATE_HOME': xdg}):
                expected = Path(xdg) if xdg and Path(xdg).is_absolute() else Path(self.env['HOME']) / '.local/state'
                self.assertEqual(auth.store_directory('mcp.datadoghq.com'), expected / 'pi/datadog-mcp/mcp.datadoghq.com')

    def test_domain_rejects_paths_urls_ports_and_normalizes_hostname(self):
        for domain in ['.', '..', '../secret', 'https://mcp.datadoghq.com', 'mcp.datadoghq.com:443', 'a..b', '-a.com', 'a_.com']:
            with self.subTest(domain=domain), mock.patch.dict(os.environ, {'DATADOG_MCP_DOMAIN': domain}):
                with self.assertRaises(auth.AuthError):
                    auth.resolve_domain()
        with mock.patch.dict(os.environ, {'DATADOG_MCP_DOMAIN': ' MCP.US3.DATADOGHQ.COM '}):
            self.assertEqual(auth.resolve_domain(), 'mcp.us3.datadoghq.com')

    def test_fresh_token_stdout_contains_only_credential_and_no_network(self):
        self.seed()
        result = self.cli('token')
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, 'synthetic-access\n', ''))
        self.assertEqual(self.run_main('token'), (0, 'synthetic-access\n', ''))
        self.http.assert_not_called()
        self.browser.assert_not_called()

    def test_status_is_offline_nonsecret_and_does_not_claim_refresh_validity(self):
        self.seed()
        code, stdout, stderr = self.run_main('status')
        self.assertEqual(code, 0)
        result = json.loads(stdout)
        self.assertEqual(result['state'], 'access_token_valid')
        self.assertTrue(result['client_registered'])
        self.assertTrue(result['refresh_token_present'])
        self.assertEqual(result['refresh_validity'], 'not_checked')
        self.assertNotIn('synthetic', stdout + stderr)
        self.http.assert_not_called()
        self.seed({**self.tokens, 'expiresAt': 1})
        self.assertEqual(json.loads(self.run_main('status')[1])['state'], 'expired')

    def test_missing_grant_fails_without_login_or_stdout(self):
        code, stdout, stderr = self.run_main('token')
        self.assertEqual(code, 1)
        self.assertEqual(stdout, '')
        self.assertIn('login', stderr)
        self.assertEqual(json.loads(self.run_main('status')[1]), {'state': 'not_signed_in', 'client_registered': False})
        self.http.assert_not_called()
        self.browser.assert_not_called()

    def test_refresh_uses_saved_client_resource_and_endpoint_without_dcr(self):
        self.seed({**self.tokens, 'expiresAt': 1})
        self.http.side_effect = None
        self.http.return_value = {'access_token': 'synthetic-new-access', 'refresh_token': 'synthetic-new-refresh', 'expires_in': 3600}
        before = time.time() * 1000
        self.assertEqual(self.run_main('token'), (0, 'synthetic-new-access\n', ''))
        self.http.assert_called_once_with(self.client['token_endpoint'], {
            'grant_type': 'refresh_token', 'refresh_token': 'synthetic-refresh',
            'client_id': 'synthetic-client', 'resource': self.client['mcp_resource_uri'],
        }, form=True)
        saved = auth.read_json(self.directory / 'tokens.json')
        self.assertEqual(saved['refreshToken'], 'synthetic-new-refresh')
        self.assertEqual(saved['scope'], self.tokens['scope'])
        self.assertGreaterEqual(saved['expiresAt'], before + 3_600_000)
        self.assertEqual(auth.read_json(self.directory / 'client.json'), self.client)
        self.browser.assert_not_called()

    def test_refresh_preserves_omitted_refresh_token_and_scope_and_default_expiry(self):
        with mock.patch.object(auth.time, 'time', return_value=100):
            result = auth.normalize_tokens({'access_token': 'new'}, self.tokens)
        self.assertEqual(result, {**self.tokens, 'accessToken': 'new', 'expiresAt': 3_700_000})

    def test_refresh_boundary_and_explicit_force(self):
        self.http.side_effect = None
        self.http.return_value = {'access_token': 'new'}
        for remaining, forced, calls in [(300_001, False, 0), (300_000, False, 1), (3_600_000, True, 1)]:
            with self.subTest(remaining=remaining, forced=forced), mock.patch.object(auth.time, 'time', return_value=1000):
                self.seed({**self.tokens, 'expiresAt': 1_000_000 + remaining})
                self.http.reset_mock()
                self.run_main('token', *(['--refresh'] if forced else []))
                self.assertEqual(self.http.call_count, calls)

    def test_refresh_does_not_require_current_callback_port(self):
        self.seed({**self.tokens, 'expiresAt': 1})
        self.http.side_effect = None
        self.http.return_value = {'access_token': 'new'}
        with mock.patch.dict(os.environ, {'DATADOG_MCP_CALLBACK_PORT': '19899'}):
            self.assertEqual(self.run_main('token')[0], 0)

    def test_refresh_failure_does_not_retry_or_modify_store(self):
        self.seed({**self.tokens, 'expiresAt': 1})
        original = (self.directory / 'tokens.json').read_bytes()
        self.http.side_effect = auth.AuthError('OAuth request failed.')
        code, stdout, stderr = self.run_main('token')
        self.assertEqual((code, stdout), (1, ''))
        self.assertNotIn('synthetic', stderr)
        self.assertEqual((self.directory / 'tokens.json').read_bytes(), original)
        self.http.assert_called_once()

    def test_missing_refresh_token_or_client_never_attempts_login(self):
        self.seed({'accessToken': 'access', 'expiresAt': 1})
        self.assertEqual(self.run_main('token')[0], 1)
        self.seed({**self.tokens, 'expiresAt': 1})
        (self.directory / 'client.json').unlink()
        self.assertEqual(self.run_main('token')[0], 1)
        self.http.assert_not_called()
        self.browser.assert_not_called()

    def test_failed_refresh_persistence_emits_no_token(self):
        self.seed({**self.tokens, 'expiresAt': 1})
        self.http.side_effect = None
        self.http.return_value = {'access_token': 'secret-new-access', 'refresh_token': 'secret-new-refresh'}
        with mock.patch.object(auth, 'write_json', side_effect=OSError('secret-new-refresh')):
            code, stdout, stderr = self.run_main('token')
        self.assertEqual((code, stdout), (1, ''))
        self.assertNotIn('secret', stderr)
        self.assertEqual(auth.read_json(self.directory / 'tokens.json')['refreshToken'], 'synthetic-refresh')

    def test_token_validation_rejects_malformed_values_without_echoing_them(self):
        for updates in [{'accessToken': ''}, {'accessToken': ' '}, {'accessToken': 'secret\r\nheader'}, {'expiresAt': True},
                        {'expiresAt': float('inf')}, {'expiresAt': 10**400}, {'expiresAt': -1}, {'refreshToken': 5}]:
            with self.subTest(updates=updates), self.assertRaises(auth.AuthError):
                auth.validate_tokens({**self.tokens, **updates})
        for response in [{'access_token': ''}, {'access_token': 'x', 'token_type': None},
                         {'access_token': 'x', 'token_type': 'Other'}, {'access_token': 'x', 'expires_in': False},
                         {'access_token': 'x', 'expires_in': -1}, {'access_token': 'x', 'expires_in': 10**400}]:
            with self.subTest(response=response), self.assertRaises(auth.AuthError):
                auth.normalize_tokens(response)

    def test_https_urls_reject_userinfo_fragments_plain_http_and_controls(self):
        for url in ['http://example.invalid/token', 'https://user:password@example.invalid/token',
                    'https://example.invalid/token#fragment', 'https://example.invalid:bad/token',
                    'https://example.invalid/\nsecret', None, 1]:
            with self.subTest(url=url), self.assertRaises(auth.AuthError):
                auth.https_url(url)

    def test_files_are_private_atomic_and_symlinks_or_hardlinks_are_rejected(self):
        self.seed()
        for path in [self.directory.parent, self.directory]:
            self.assertEqual(path.stat().st_mode & 0o777, 0o700)
        for path in self.directory.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        token_path = self.directory / 'tokens.json'
        target = self.root / 'outside'
        target.write_text('do not read or replace')
        token_path.unlink()
        token_path.symlink_to(target)
        self.assertEqual(self.run_main('token')[0], 1)
        self.assertEqual(target.read_text(), 'do not read or replace')
        token_path.unlink()
        os.link(target, token_path)
        self.assertEqual(self.run_main('token')[0], 1)
        self.assertEqual(target.read_text(), 'do not read or replace')

    def test_symlinked_directory_and_lock_are_rejected(self):
        self.directory.parent.mkdir(parents=True)
        target = self.root / 'outside'
        target.mkdir()
        self.directory.symlink_to(target, target_is_directory=True)
        self.assertEqual(self.run_main('status')[0], 1)
        self.assertEqual(list(target.iterdir()), [])
        self.directory.unlink()
        self.seed()
        (self.directory / '.lock').unlink()
        (self.directory / '.lock').symlink_to(self.directory / 'tokens.json')
        self.assertEqual(self.run_main('status')[0], 1)

    def test_failed_atomic_replace_keeps_old_tokens_and_cleans_temporary_file(self):
        self.seed()
        with mock.patch.object(auth.os, 'replace', side_effect=OSError('write failed')):
            with self.assertRaises(OSError):
                auth.write_json(self.directory / 'tokens.json', {**self.tokens, 'accessToken': 'new'})
        self.assertEqual(auth.read_json(self.directory / 'tokens.json'), self.tokens)
        self.assertEqual(list(self.directory.glob('*.tmp')), [])

    def test_malformed_oversized_and_public_files_fail_without_printing_contents(self):
        self.seed()
        path = self.directory / 'tokens.json'
        for data in ['secret invalid JSON', '[]', 'x' * (auth.MAX_JSON_BYTES + 1)]:
            path.write_text(data)
            code, stdout, stderr = self.run_main('token')
            self.assertEqual((code, stdout), (1, ''))
            self.assertNotIn('secret', stderr)
        self.seed()
        path.chmod(0o644)
        self.assertEqual(self.run_main('token')[0], 1)

    def test_concurrent_helpers_reread_under_lock_and_refresh_only_once(self):
        self.seed({**self.tokens, 'expiresAt': 1})
        workers = [self.worker(), self.worker()]
        for process in workers:
            stdout, stderr = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 0, stderr)
            self.assertEqual(stdout, 'synthetic-new-access\n')
        self.assertEqual((self.root / 'refreshes').read_text(), 'refresh\n')
        self.assertEqual(auth.read_json(self.directory / 'tokens.json')['refreshToken'], 'synthetic-new-refresh')

    def test_logout_serializes_after_refresh_and_does_not_get_resurrected(self):
        self.seed({**self.tokens, 'expiresAt': 1})
        worker = self.worker()
        self.assertEqual(worker.stderr.readline(), 'refreshing\n')
        result = self.cli('logout')
        self.assertEqual(result.returncode, 0, result.stderr)
        worker.communicate(timeout=10)
        self.assertEqual(worker.returncode, 0)
        self.assertFalse((self.directory / 'tokens.json').exists())
        self.assertEqual(auth.read_json(self.directory / 'client.json'), self.client)

    def test_lock_wait_is_bounded_and_process_death_releases_lock(self):
        self.seed()
        holder = subprocess.Popen([sys.executable, '-c',
            'import fcntl,sys,time; f=open(sys.argv[1],"r+"); fcntl.flock(f,fcntl.LOCK_EX); print("locked",flush=True); time.sleep(30)',
            str(self.directory / '.lock')], env=self.env, stdout=subprocess.PIPE, text=True)
        self.addCleanup(self.cleanup_process, holder)
        self.assertEqual(holder.stdout.readline(), 'locked\n')
        with mock.patch.object(auth, 'LOCK_TIMEOUT', 0.05):
            code, stdout, stderr = self.run_main('token')
        self.assertEqual((code, stdout), (1, ''))
        self.assertIn('busy', stderr)
        holder.kill()
        holder.wait(timeout=5)
        self.assertEqual(self.cli('token').stdout, 'synthetic-access\n')

    def test_logout_is_idempotent_local_only_and_keeps_registration(self):
        self.seed()
        for _ in range(2):
            self.assertEqual(self.run_main('logout')[0], 0)
        self.assertEqual(auth.read_json(self.directory / 'client.json'), self.client)
        self.assertIsNone(auth.read_json(self.directory / 'tokens.json'))
        self.http.assert_not_called()

    def test_http_transport_disables_proxies_redirects_and_bounds_requests(self):
        # Restore the real boundary, but replace its opener before any network I/O.
        original = self.http
        with mock.patch.object(urllib.request, 'build_opener') as factory:
            response = factory.return_value.open.return_value.__enter__.return_value
            response.read.return_value = b'{"access_token":"synthetic"}'
            self.assertEqual(REQUEST_JSON('https://example.invalid/token', {'refresh_token': 'synthetic'}, form=True),
                             {'access_token': 'synthetic'})
            proxy, redirects = factory.call_args.args
            self.assertEqual(proxy.proxies, {})
            self.assertIsNone(redirects.redirect_request(None, None, 302, '', {}, 'https://other.invalid'))
            request = factory.return_value.open.call_args.args[0]
            self.assertEqual(request.data, b'refresh_token=synthetic')
            self.assertEqual(factory.return_value.open.call_args.kwargs['timeout'], auth.HTTP_TIMEOUT)
            response.read.assert_called_once_with(auth.MAX_JSON_BYTES + 1)
            for raw in [b'secret invalid json', b'[]', b'{"error":"secret"}', b'x' * (auth.MAX_JSON_BYTES + 1)]:
                response.read.return_value = raw
                with self.assertRaises(auth.AuthError) as error:
                    REQUEST_JSON('https://example.invalid/token')
                self.assertNotIn('secret', str(error.exception))
            for error in [TimeoutError('secret'), http.client.BadStatusLine('secret'),
                          http.client.IncompleteRead(b'secret', 100),
                          urllib.error.HTTPError('https://example.invalid', 401, 'secret', {}, io.BytesIO(b'secret'))]:
                factory.return_value.open.side_effect = error
                before = factory.return_value.open.call_count
                with self.assertRaises(auth.AuthError) as caught:
                    REQUEST_JSON('https://example.invalid/token')
                self.assertNotIn('secret', str(caught.exception))
                self.assertEqual(factory.return_value.open.call_count, before + 1)
                self.seed({**self.tokens, 'expiresAt': 1})
                original.side_effect = REQUEST_JSON
                code, stdout, stderr = self.run_main('token')
                self.assertEqual((code, stdout), (1, ''))
                self.assertNotIn('secret', stderr)
                self.assertNotIn('Traceback', stderr)
        self.assertIs(auth.request_json, original)

    def prepare_login(self, failure=False, wrong_state=False):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        os.environ['DATADOG_MCP_CALLBACK_PORT'] = str(port)
        self.client['redirect_uris'] = [f'http://localhost:{port}/callback']
        callbacks, errors, threads = [], [], []

        def open_browser(url):
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
            callbacks.append(query)

            def callback():
                try:
                    requests = []
                    if wrong_state:
                        requests.append({'state': 'wrong', 'code': 'untrusted'})
                    requests.append({'state': query['state'][0], **({'error': 'secret-provider-error'} if failure else {'code': 'synthetic-code'})})
                    for params in requests:
                        request_url = query['redirect_uri'][0].replace('localhost', '127.0.0.1') + '?' + urllib.parse.urlencode(params)
                        try:
                            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request_url, timeout=3) as response:
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

        def join_threads():
            for thread in threads:
                thread.join(timeout=5)
                self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
        self.addCleanup(join_threads)
        return callbacks

    def test_login_reuses_registration_validates_state_and_sends_pkce_and_resource(self):
        callbacks = self.prepare_login(wrong_state=True)
        self.client['authorization_endpoint'] += '?tenant=example&state=stale'
        self.seed()
        self.http.side_effect = None
        self.http.return_value = {'access_token': 'synthetic-login-access', 'refresh_token': 'synthetic-login-refresh'}
        code, stdout, stderr = self.run_main('login')
        self.assertEqual(code, 0, stderr)
        self.assertEqual(stdout, 'Signed in to Datadog.\n')
        self.http.assert_called_once()
        url = self.http.call_args.args[0]
        body = self.http.call_args.args[1]
        self.assertEqual(url, self.client['token_endpoint'])
        self.assertEqual(body['code'], 'synthetic-code')
        self.assertEqual(body['resource'], self.client['mcp_resource_uri'])
        self.assertEqual(callbacks[0]['tenant'], ['example'])
        self.assertEqual(len(callbacks[0]['state']), 1)
        self.assertNotEqual(callbacks[0]['state'], ['stale'])
        challenge = base64.urlsafe_b64encode(hashlib.sha256(body['code_verifier'].encode()).digest()).rstrip(b'=').decode()
        self.assertEqual(callbacks[0]['code_challenge'], [challenge])
        self.assertEqual(callbacks[0]['code_challenge_method'], ['S256'])
        self.assertNotIn('scope', callbacks[0])
        self.assertNotIn('synthetic-login-', stdout + stderr)
        self.assertEqual(auth.read_json(self.directory / 'tokens.json')['refreshToken'], 'synthetic-login-refresh')

    def test_registration_preserves_overrides_and_omits_scope(self):
        self.http.side_effect = [
            {'registration_endpoint': 'https://auth.example.invalid/register',
             'authorization_endpoint': 'https://auth.example.invalid/authorize', 'token_endpoint': 'https://auth.example.invalid/token'},
            {**self.client, 'client_id': 'new-client'},
        ]
        result = auth.register_client(auth.DEFAULT_DOMAIN, self.client['redirect_uris'][0])
        self.assertEqual(result, {**self.client, 'client_id': 'new-client'})
        request = self.http.call_args_list[1].args[1]
        self.assertEqual(request['token_endpoint_auth_method'], 'none')
        self.assertNotIn('scope', request)

    def test_denied_or_timed_out_login_leaves_previous_pair_unchanged(self):
        self.prepare_login(failure=True)
        self.seed()
        code, stdout, stderr = self.run_main('login')
        self.assertEqual((code, stdout), (1, ''))
        self.assertNotIn('secret-provider-error', stderr)
        self.assertEqual(auth.read_json(self.directory / 'tokens.json'), self.tokens)
        self.http.assert_not_called()
        self.browser.side_effect = None
        with mock.patch.object(auth, 'LOGIN_TIMEOUT', 0):
            self.assertEqual(self.run_main('login')[0], 1)
        self.assertEqual(auth.read_json(self.directory / 'tokens.json'), self.tokens)
        self.http.assert_not_called()

    def test_failed_new_login_does_not_replace_registration(self):
        self.prepare_login()
        old_client = {**self.client, 'redirect_uris': ['http://localhost:1/callback']}
        self.seed(client=old_client)
        new_client = {**self.client, 'client_id': 'new-client'}
        with mock.patch.object(auth, 'register_client', return_value=new_client):
            self.http.side_effect = auth.AuthError('Exchange failed')
            self.assertEqual(self.run_main('login')[0], 1)
        self.assertEqual(auth.read_json(self.directory / 'client.json'), old_client)
        self.assertEqual(auth.read_json(self.directory / 'tokens.json'), self.tokens)

    def test_new_registration_cannot_be_paired_with_old_tokens_on_write_failure(self):
        self.prepare_login()
        old_client = {**self.client, 'redirect_uris': ['http://localhost:1/callback']}
        self.seed(client=old_client)
        new_client = {**self.client, 'client_id': 'new-client'}
        self.http.side_effect = None
        self.http.return_value = {'access_token': 'new'}
        with mock.patch.object(auth, 'register_client', return_value=new_client), \
             mock.patch.object(auth, 'write_json', side_effect=OSError('failed')):
            self.assertEqual(self.run_main('login')[0], 1)
        self.assertEqual(auth.read_json(self.directory / 'client.json'), old_client)
        self.assertFalse((self.directory / 'tokens.json').exists())

    def test_cancellation_during_callback_handling_aborts_login_without_exchange(self):
        self.prepare_login()
        self.browser.side_effect = None
        self.seed()
        for signum in [signal.SIGTERM, signal.SIGALRM]:
            with self.subTest(signum=signum):
                request, peer = socket.socketpair()
                with request, peer, \
                     mock.patch.object(auth.CallbackServer, 'handle_request', auth.CallbackServer._handle_request_noblock), \
                     mock.patch.object(auth.CallbackServer, 'get_request', return_value=(request, ('127.0.0.1', 1))), \
                     mock.patch.object(auth.CallbackServer, 'finish_request', side_effect=lambda *_: auth.interrupt(signum, None)):
                    code, stdout, stderr = self.run_main('login')
                self.assertEqual((code, stdout), (1, ''))
                self.assertIn('interrupted', stderr)
                self.assertNotIn('Traceback', stderr)
                self.http.assert_not_called()
                self.assertEqual(auth.read_json(self.directory / 'tokens.json'), self.tokens)

    def test_callback_errors_are_silent_and_browser_failure_allows_manual_login(self):
        self.prepare_login()
        self.browser.side_effect = OSError('browser failure')
        self.seed()
        with mock.patch.object(auth, 'LOGIN_TIMEOUT', 0):
            code, stdout, stderr = self.run_main('login')
        self.assertEqual((code, stdout), (1, ''))
        self.assertIn('Open this URL', stderr)
        self.assertIn('Login timed out', stderr)
        with auth.CallbackServer(('127.0.0.1', 0), auth.http.server.BaseHTTPRequestHandler) as server:
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                try:
                    raise ValueError('secret callback data')
                except ValueError:
                    server.handle_error(None, ('127.0.0.1', 1))
            self.assertEqual(stderr.getvalue(), '')

    def test_callback_port_is_validated_and_refresh_flag_is_token_only(self):
        for value in ['0', '65536', '19876garbage', '１２３']:
            with mock.patch.dict(os.environ, {'DATADOG_MCP_CALLBACK_PORT': value}), self.assertRaises(auth.AuthError):
                auth.callback_url()
        result = self.cli('status', '--refresh')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, '')


if __name__ == '__main__':
    unittest.main()
