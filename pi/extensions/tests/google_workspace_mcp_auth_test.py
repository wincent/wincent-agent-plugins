import base64
import contextlib
import copy
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
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import patch

HELPER = Path(__file__).resolve().parents[1] / 'bin/google-workspace-mcp-auth'
auth = types.ModuleType('workspace_auth')
importlib.machinery.SourceFileLoader(auth.__name__, str(HELPER)).exec_module(auth)
RESOURCE = 'https://workspace.example.invalid/mcp'
BASE = RESOURCE[:-4]
REAL_REQUEST = auth.request_json
WORKER = '''
import importlib.machinery,sys,time,types
from pathlib import Path
m=types.ModuleType('workspace_worker')
importlib.machinery.SourceFileLoader(m.__name__,sys.argv[1]).exec_module(m)
def refresh(resource,url,body=None,form=False):
 assert body['refresh_token']=='old-refresh', 'Unexpected second refresh'
 with open(sys.argv[2],'a') as f:f.write('refresh\\n')
 print('refreshing',file=sys.stderr,flush=True)
 time.sleep(0.2)
 return {'access_token':'new-access','refresh_token':'new-refresh','token_type':'Bearer','expires_in':3600}
m.request_json=refresh
sys.exit(m.main(['token']))
'''


def response(**changes):
    return {'access_token': 'new-access', 'refresh_token': 'new-refresh', 'token_type': 'Bearer', 'expires_in': 3600, **changes}


class WorkspaceAuthTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = patch.dict(os.environ, {'HOME': self.temp.name, 'XDG_STATE_HOME': self.temp.name,
                                          'GOOGLE_WORKSPACE_MCP_URL': RESOURCE}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        for name, target in [('request_json', auth), ('open', auth.webbrowser)]:
            mock = patch.object(target, name, side_effect=AssertionError('Unexpected network or browser call'))
            mock.start()
            self.addCleanup(mock.stop)
        for signum in (signal.SIGALRM, signal.SIGTERM):
            self.addCleanup(signal.signal, signum, signal.getsignal(signum))
        self.directory = auth.store_directory(RESOURCE)
        self.client = {'clientId': 'test-client', 'resourceUri': RESOURCE, 'issuer': BASE + '/',
                       'tokenEndpointAuthMethod': 'none', 'redirectUri': 'http://127.0.0.1:19877/callback',
                       'scope': ' '.join(auth.SCOPES)}
        self.tokens = auth.normalize_tokens(response(access_token='old-access', refresh_token='old-refresh'), self.client)
        self.grant = {'client': self.client, 'tokens': self.tokens}
        self.protected = {'resource': RESOURCE, 'authorization_servers': [BASE + '/'], 'scopes_supported': list(auth.SCOPES)}
        self.metadata = {'issuer': BASE + '/', 'authorization_endpoint': BASE + '/authorize', 'token_endpoint': BASE + '/token',
                         'registration_endpoint': BASE + '/register', 'response_types_supported': ['code'],
                         'grant_types_supported': ['authorization_code', 'refresh_token'],
                         'code_challenge_methods_supported': ['S256'],
                         'token_endpoint_auth_methods_supported': ['client_secret_post', 'client_secret_basic']}

    def save(self, value=None):
        with auth.locked(self.directory):
            auth.write_json(self.directory / 'grant.json', self.grant if value is None else value)

    def read(self):
        with auth.locked(self.directory):
            return auth.read_grant(self.directory, RESOURCE)

    def main(self, *args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = auth.main(list(args))
        return code, stdout.getvalue(), stderr.getvalue()

    def fake_request(self, resource, url, body=None, form=False):
        self.assertEqual(resource, RESOURCE)
        if url.endswith('/.well-known/oauth-protected-resource/mcp'):
            return self.protected
        if url.endswith('/.well-known/oauth-authorization-server'):
            return self.metadata
        if url.endswith('/register'):
            self.assertFalse(form)
            self.assertEqual(body['token_endpoint_auth_method'], 'none')
            self.assertEqual(set(body['scope'].split()), set(auth.SCOPES))
            self.assertNotIn('client_secret', body)
            return {'client_id': 'registered-client', 'redirect_uris': body['redirect_uris'],
                    'token_endpoint_auth_method': 'none', 'client_secret': 'not-needed-and-not-saved'}
        self.assertEqual(url, BASE + '/token')
        self.assertTrue(form)
        self.assertNotIn('client_secret', body)
        self.assertEqual(body['resource'], RESOURCE)
        return response()

    def test_store_is_separate_from_legacy_and_uses_unambiguous_resource_hash(self):
        self.assertEqual(self.directory.parent.name, 'google-workspace-mcp-host')
        self.assertEqual(self.directory.name, hashlib.sha256(RESOURCE.encode()).hexdigest())
        for xdg in ('', 'relative'):
            with patch.dict(os.environ, {'XDG_STATE_HOME': xdg}):
                self.assertEqual(auth.store_directory(RESOURCE).parents[2], Path(self.temp.name) / '.local/state')
        other = auth.store_directory('https://other.example.invalid/mcp')
        self.assertNotEqual(other, self.directory)

    def test_resource_and_callback_validation(self):
        self.assertEqual(auth.resource_url(), RESOURCE)
        for value in ('', 'http://workspace.example.invalid/mcp', 'https://user:pass@example.invalid/mcp',
                      RESOURCE + '?token=secret', RESOURCE + '#fragment', 'https://example.invalid:99/mcp',
                      'https://example.invalid/mcp/', 'https://ex ample.invalid/mcp', 'https://example.invalid/other'):
            with self.subTest(value=value), patch.dict(os.environ, {'GOOGLE_WORKSPACE_MCP_URL': value}):
                with self.assertRaises(auth.AuthError): auth.resource_url()
        for port in ('123junk', '0', '65536', '-1', '１２３', ' '):
            with patch.dict(os.environ, {'GOOGLE_WORKSPACE_MCP_CALLBACK_PORT': port}):
                with self.assertRaises(auth.AuthError): auth.callback_url()

    def test_fresh_token_and_status_are_offline_and_do_not_read_legacy_store(self):
        self.save()
        legacy = Path(self.temp.name) / 'pi/google-workspace-mcp/legacy/tokens.json'
        legacy.parent.mkdir(parents=True)
        legacy.write_text('legacy-private-sentinel')
        with patch.object(auth, 'request_json', side_effect=AssertionError('network forbidden')):
            self.assertEqual(self.main('token'), (0, 'old-access\n', ''))
            code, out, err = self.main('status')
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)['refresh_validity'], 'not_checked')
        self.assertNotIn('old-access', out + err)
        self.assertNotIn('old-refresh', out + err)
        self.assertEqual(legacy.read_text(), 'legacy-private-sentinel')

    def test_missing_grant_does_not_login_or_register(self):
        with patch.object(auth, 'request_json', side_effect=AssertionError('network forbidden')):
            code, out, err = self.main('token')
        self.assertEqual(code, 1)
        self.assertEqual(out, '')
        self.assertIn('login', err)

    def test_refresh_body_and_atomic_bound_pair(self):
        self.save()
        with patch.object(auth, 'request_json', side_effect=self.fake_request) as request:
            self.assertEqual(self.main('token', '--refresh'), (0, 'new-access\n', ''))
        request.assert_called_once_with(RESOURCE, BASE + '/token', {
            'grant_type': 'refresh_token', 'refresh_token': 'old-refresh', 'client_id': 'test-client',
            'resource': RESOURCE,
        }, form=True)
        saved = self.read()
        self.assertEqual(saved['client'], self.client)
        self.assertEqual(saved['tokens']['refreshToken'], 'new-refresh')

    def test_expiry_buffer_and_force(self):
        self.tokens['expiresAt'] = 1_000_000 + auth.REFRESH_BUFFER_MS
        self.save()
        with patch.object(auth.time, 'time', return_value=1000), patch.object(auth, 'request_json', return_value=response()) as request:
            self.assertEqual(self.main('token')[0], 0)
            self.assertEqual(request.call_count, 1)

    def test_refresh_failures_do_not_retry_delete_or_expose_grant(self):
        self.save()
        for failure in (auth.AuthError('OAuth rejected'), OSError('sensitive-storage-detail')):
            with patch.object(auth, 'request_json', side_effect=failure) as request:
                code, out, err = self.main('token', '--refresh')
            self.assertEqual((code, out), (1, ''))
            self.assertEqual(request.call_count, 1)
            self.assertNotIn('sensitive-storage-detail', err)
            self.assertEqual(self.read(), self.grant)

    def test_save_failure_never_emits_new_access_token(self):
        self.save()
        with patch.object(auth, 'request_json', return_value=response()), patch.object(auth.os, 'replace', side_effect=OSError('private')):
            code, out, err = self.main('token', '--refresh')
        self.assertEqual((code, out), (1, ''))
        self.assertNotIn('new-access', err)
        self.assertEqual(self.read(), self.grant)
        self.assertFalse(list(self.directory.glob('*.tmp')))

    def test_post_replace_sync_failure_retains_complete_new_pair_without_output(self):
        for command in (['token', '--refresh'], ['login']):
            self.save()
            with patch.dict(os.environ, {'GOOGLE_WORKSPACE_MCP_CALLBACK_PORT': str(self.free_port())}), \
                 patch.object(auth, 'request_json', side_effect=self.fake_request), \
                 patch.object(auth.webbrowser, 'open', side_effect=self.browser), \
                 patch.object(auth, 'sync_directory', side_effect=OSError('private-sync-detail')):
                code, out, err = self.main(*command)
                if command == ['login']:
                    self.thread.join(5)
            self.assertEqual((code, out), (1, ''))
            self.assertNotIn('private-sync-detail', err)
            self.assertNotIn('new-access', err)
            saved = self.read()
            expected_client = 'registered-client' if command == ['login'] else 'test-client'
            self.assertEqual(saved['client']['clientId'], expected_client)
            self.assertEqual(saved['tokens']['clientId'], expected_client)
            self.assertEqual(saved['tokens']['refreshToken'], 'new-refresh')
            self.assertFalse(list(self.directory.glob('*.tmp')))

    def test_refresh_can_retain_an_unrotated_token_but_initial_login_requires_one(self):
        data = response(); del data['refresh_token']
        self.assertEqual(auth.normalize_tokens(data, self.client, self.tokens)['refreshToken'], 'old-refresh')
        with self.assertRaises(auth.AuthError): auth.normalize_tokens(data, self.client)
        with self.assertRaises(auth.AuthError): auth.normalize_tokens(response(refresh_token=''), self.client, self.tokens)

    def test_google_identity_scope_aliases_are_canonicalized_for_login_and_refresh(self):
        aliases = {short: full for full, short in auth.SCOPE_ALIASES.items()}
        scope = ' '.join(aliases.get(part, part) for part in auth.SCOPES)
        tokens = auth.normalize_tokens(response(scope=scope), self.client)
        self.assertEqual(tokens['scope'], self.client['scope'])
        self.assertEqual(self.client['scope'], ' '.join(auth.SCOPES))
        self.save()
        with patch.object(auth, 'request_json', return_value=response(scope=scope)) as request:
            self.assertEqual(self.main('token', '--refresh'), (0, 'new-access\n', ''))
        self.assertNotIn('scope', request.call_args.args[2])
        self.assertEqual(self.read()['tokens']['scope'], self.client['scope'])
        self.assertEqual(auth.normalize_tokens(response(), self.client, tokens)['scope'], self.client['scope'])

    def test_scope_aliases_do_not_allow_missing_extra_or_malformed_permissions(self):
        aliases = {short: full for full, short in auth.SCOPE_ALIASES.items()}
        scope = ' '.join(aliases.get(part, part) for part in auth.SCOPES)
        bad_scopes = (scope.replace('https://www.googleapis.com/auth/userinfo.email', ''),
                      scope + ' https://www.googleapis.com/auth/gmail.readonly',
                      scope.replace('https://www.googleapis.com/auth/userinfo.profile',
                                    'https://www.googleapis.com/auth/userinfo.profile.extra'),
                      scope.replace(' ', '\n', 1), scope.replace(' ', '\t', 1), None, [])
        for bad in bad_scopes:
            with self.subTest(scope=bad), self.assertRaises(auth.AuthError):
                auth.normalize_tokens(response(scope=bad), self.client)
        self.tokens['scope'] = scope
        self.save()
        with self.assertRaises(auth.AuthError):
            self.read()

    def test_full_drive_scope_is_explicitly_requested_and_accepted(self):
        with patch.object(auth, 'request_json', side_effect=self.fake_request):
            client = auth.register_client(RESOURCE, self.client['redirectUri'], self.client['issuer'])
        self.assertIn('https://www.googleapis.com/auth/drive', client['scope'].split())
        tokens = auth.normalize_tokens(response(scope=client['scope']), client)
        self.assertEqual(tokens['scope'], client['scope'])

    def test_old_scope_grant_requires_explicit_reset_before_reauthorization(self):
        old_scope = ' '.join(scope for scope in auth.SCOPES if scope != 'https://www.googleapis.com/auth/drive')
        self.client['scope'] = self.tokens['scope'] = old_scope
        self.save()
        for command in ('token', 'login'):
            self.assertEqual(self.main(command)[0], 1)
            self.assertEqual(auth.read_json(self.directory / 'grant.json'), self.grant)
        self.assertEqual(self.main('logout')[0], 0)
        self.assertIsNone(self.read())
        self.assertEqual(json.loads(self.main('status')[1]), {'state': 'not_signed_in'})

    def test_token_validation_diagnostics_identify_fields_without_response_values(self):
        cases = [
            ({'refresh_token': None}, 'refreshToken'),
            ({'access_token': 'private-access\nvalue'}, 'accessToken'),
            ({'scope': self.client['scope'] + ' private-scope'}, 'scope (missing 0, additional 1, includes full Drive access)'),
            ({'scope': 'openid'}, f'scope (missing {len(auth.SCOPES) - 1}, additional 0)'),
            ({'scope': None}, 'scope'),
        ]
        for changes, diagnostic in cases:
            with self.subTest(changes=changes), self.assertRaises(auth.AuthError) as failure:
                auth.normalize_tokens(response(**changes), self.client)
            message = str(failure.exception)
            self.assertIn(diagnostic, message)
            for private in ('new-access', 'new-refresh', 'private-access', 'private-scope'):
                self.assertNotIn(private, message)

    def test_token_validation_expiry_type_scopes_and_binding(self):
        for changes in ({'expires_in': None}, {'expires_in': False}, {'expires_in': 0}, {'expires_in': -1},
                        {'expires_in': float('inf')}, {'expires_in': 10**400}, {'expires_in': 1e308},
                        {'token_type': 'user'}, {'token_type': None}, {'access_token': 'bad\nsecret'},
                        {'refresh_token': ' '}, {'scope': 'openid'}, {'scope': self.client['scope'] + ' unexpected'},
                        {'error': 'secret-error'}):
            with self.subTest(changes=changes), self.assertRaises(auth.AuthError):
                auth.normalize_tokens(response(**changes), self.client)
        for section, key, value in [('tokens', 'clientId', 'other'), ('tokens', 'resourceUri', 'https://other.invalid/mcp'),
                                    ('client', 'issuer', 'https://other.invalid'), ('client', 'tokenEndpointAuthMethod', 'client_secret_post'),
                                    ('client', 'redirectUri', 'http://other.invalid/callback')]:
            bad = copy.deepcopy(self.grant); bad[section][key] = value; self.save(bad)
            with self.assertRaises(auth.AuthError): self.read()

    def test_discovery_pins_issuer_resource_endpoints_and_scopes(self):
        with patch.object(auth, 'request_json', side_effect=self.fake_request):auth.discover(RESOURCE)
        for target, key, value in [('protected', 'resource', 'https://other.invalid/mcp'),
                                   ('protected', 'authorization_servers', ['https://other.invalid']),
                                   ('protected', 'scopes_supported', None),
                                   ('protected', 'scopes_supported', ' '.join(auth.SCOPES)),
                                   ('protected', 'scopes_supported', list(auth.SCOPES) + [{}]),
                                   ('metadata', 'issuer', 'https://other.invalid'),
                                   ('metadata', 'token_endpoint', 'https://other.invalid/token'),
                                   ('metadata', 'registration_endpoint', BASE + '/other'),
                                   ('metadata', 'code_challenge_methods_supported', ['plain']),
                                   ('metadata', 'grant_types_supported', ['authorization_code']),
                                   ('metadata', 'response_types_supported', None),
                                   ('metadata', 'token_endpoint_auth_methods_supported', ['unknown'])]:
            data = getattr(self, target); old = data[key]; data[key] = value
            try:
                with self.subTest(key=key), patch.object(auth, 'request_json', side_effect=self.fake_request), self.assertRaises(auth.AuthError):
                    auth.discover(RESOURCE)
            finally:data[key] = old

    def test_discovery_allows_additional_scopes_without_requesting_them(self):
        self.protected['scopes_supported'].append('https://www.googleapis.com/auth/gmail.readonly')
        with patch.object(auth, 'request_json', side_effect=self.fake_request):
            issuer = auth.discover(RESOURCE)
            client = auth.register_client(RESOURCE, self.client['redirectUri'], issuer)
        self.assertEqual(client['scope'], ' '.join(auth.SCOPES))
        self.assertNotIn('https://www.googleapis.com/auth/gmail.readonly', client['scope'].split())

    def test_discovery_requires_every_requested_scope(self):
        for missing in auth.SCOPES:
            self.protected['scopes_supported'] = [scope for scope in auth.SCOPES if scope != missing]
            self.protected['scopes_supported'].append('https://www.googleapis.com/auth/gmail.readonly')
            with self.subTest(missing=missing), patch.object(auth, 'request_json', side_effect=self.fake_request):
                with self.assertRaises(auth.AuthError):
                    auth.discover(RESOURCE)

    def test_discovery_preserves_exact_root_issuer_with_or_without_trailing_slash(self):
        for issuer in (BASE, BASE + '/'):
            self.protected['authorization_servers'] = [issuer]
            self.metadata['issuer'] = issuer
            with patch.object(auth, 'request_json', side_effect=self.fake_request):
                self.assertEqual(auth.discover(RESOURCE), issuer)
        self.protected['authorization_servers'] = [BASE]
        with patch.object(auth, 'request_json', side_effect=self.fake_request), self.assertRaises(auth.AuthError):
            auth.discover(RESOURCE)

    def test_registration_confidential_method_missing_callback_and_scope_change_fail(self):
        good = {'client_id': 'id', 'redirect_uris': [self.client['redirectUri']], 'token_endpoint_auth_method': 'none'}
        for changes in ({'token_endpoint_auth_method': 'client_secret_post'}, {'redirect_uris': []},
                        {'redirect_uris': None}, {'scope': 'openid'}, {'client_id': ''}):
            with patch.object(auth, 'request_json', return_value={**good, **changes}), self.assertRaises(auth.AuthError):
                auth.register_client(RESOURCE, self.client['redirectUri'], self.client['issuer'])

    def test_private_modes_hardlinks_and_symlinks(self):
        self.save(); path = self.directory / 'grant.json'
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o700)
        alias = self.directory / 'alias'; os.link(path, alias)
        with self.assertRaises(auth.AuthError):self.read()
        alias.unlink(); path.chmod(0o644)
        with self.assertRaises(auth.AuthError):self.read()
        path.chmod(0o600); path.rename(alias); path.symlink_to(alias)
        with self.assertRaises(OSError):self.read()

    def test_symlinked_directory_and_lock_are_rejected(self):
        self.directory.parent.mkdir(parents=True)
        target = Path(self.temp.name) / 'target'; target.mkdir()
        self.directory.symlink_to(target)
        with self.assertRaises(auth.AuthError):
            with auth.locked(self.directory):pass
        self.directory.unlink(); self.directory.mkdir(mode=0o700)
        lock = self.directory / '.lock'; lock.symlink_to(target / 'lock')
        with self.assertRaises(OSError):
            with auth.locked(self.directory):pass

    def test_bounded_malformed_and_oversized_json(self):
        self.save(); path = self.directory / 'grant.json'
        for content in ('not json', '[]', ' ' * (auth.MAX_JSON_BYTES + 1)):
            path.write_text(content)
            code, out, err = self.main('status')
            self.assertEqual((code, out), (1, ''))
            self.assertNotIn(content[:40], err)

    def test_http_rejects_unapproved_urls_redirects_proxies_and_raw_errors(self):
        patcher = patch.object(auth, 'request_json', REAL_REQUEST)
        patcher.start()
        self.addCleanup(patcher.stop)
        for url in ('http://workspace.example.invalid/token', BASE + '/unapproved', 'https://other.invalid/token'):
            with self.assertRaises(auth.AuthError):auth.request_json(RESOURCE, url)
        handler = auth.NoRedirect()
        self.assertIsNone(handler.redirect_request(None, None, 302, '', {}, 'https://other.invalid'))
        request_seen = []
        class Response:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,n):return b'{"value": true}'
        def open_request(request,timeout):
            request_seen.append(request)
            self.assertEqual(timeout, auth.HTTP_TIMEOUT)
            return Response()
        opener = types.SimpleNamespace(open=open_request)
        with patch.object(auth.urllib.request, 'build_opener', return_value=opener) as build:
            auth.request_json(RESOURCE, BASE + '/register', {'a':'b'})
            auth.request_json(RESOURCE, BASE + '/token', {'a':'b'}, form=True)
        self.assertEqual(build.call_args.args[0].proxies, {})
        self.assertIsInstance(build.call_args.args[1], auth.NoRedirect)
        self.assertEqual(request_seen[0].data, b'{"a": "b"}')
        self.assertEqual(request_seen[1].data, b'a=b')
        for body in (b'{"error":"invalid_grant","error_description":"private-sentinel"}',
                     b'{"error":"private-sentinel"}', b'invalid private-sentinel', b'x' * (auth.MAX_JSON_BYTES + 1)):
            error = urllib.error.HTTPError(BASE + '/token', 400, 'private-sentinel', {}, io.BytesIO(body))
            opener.open = lambda *a, **kw: (_ for _ in ()).throw(error)
            with patch.object(auth.urllib.request, 'build_opener', return_value=opener):
                with self.assertRaises(auth.AuthError) as result:auth.request_json(RESOURCE, BASE + '/token')
            self.assertNotIn('private-sentinel', str(result.exception))
            self.assertEqual('invalid_grant' in str(result.exception), b'"invalid_grant"' in body)

    def browser(self, url, *, denied=False, wrong_issuer=False):
        params = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        self.login_params = params
        target = params['redirect_uri'][0]
        def callback():
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            for query in ({'state':'incorrect','code':'code'},
                          {'state':[params['state'][0],params['state'][0]],'code':'code'},
                          {'state':params['state'][0], **({'error':'denied'} if denied else {'code':'code'}),
                           'iss':'https://other.invalid' if wrong_issuer else self.metadata['issuer']}):
                try:
                    with opener.open(target + '?' + urllib.parse.urlencode(query, doseq=True), timeout=3) as result:result.read()
                except urllib.error.HTTPError as e:e.close()
        self.thread = threading.Thread(target=callback); self.thread.start()
        return True

    def free_port(self):
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));return sock.getsockname()[1]

    def test_login_uses_public_dcr_pkce_bound_pair_and_separate_store(self):
        self.protected['scopes_supported'].append('https://www.googleapis.com/auth/gmail.readonly')
        with patch.dict(os.environ, {'GOOGLE_WORKSPACE_MCP_CALLBACK_PORT': str(self.free_port())}), \
             patch.object(auth, 'request_json', side_effect=self.fake_request) as request, \
             patch.object(auth.webbrowser, 'open', side_effect=self.browser):
            code,out,err=self.main('login');self.thread.join(5)
        self.assertEqual(code,0,err)
        self.assertNotIn('new-access',out+err)
        body=request.call_args.args[2]
        challenge=base64.urlsafe_b64encode(hashlib.sha256(body['code_verifier'].encode()).digest()).rstrip(b'=').decode()
        self.assertEqual(self.login_params['code_challenge'],[challenge])
        self.assertEqual(body['grant_type'],'authorization_code')
        saved=self.read()
        self.assertEqual(saved['client']['clientId'],'registered-client')
        self.assertEqual(saved['tokens']['clientId'],'registered-client')
        self.assertEqual(self.login_params['scope'], [' '.join(auth.SCOPES)])
        self.assertEqual(saved['client']['scope'], ' '.join(auth.SCOPES))
        self.assertEqual(saved['tokens']['scope'], ' '.join(auth.SCOPES))
        self.assertIn('https://www.googleapis.com/auth/drive', auth.SCOPES)
        self.assertNotIn('https://www.googleapis.com/auth/gmail.readonly', auth.SCOPES)
        self.assertNotIn('not-needed-and-not-saved',json.dumps(saved))

    def test_denial_and_wrong_issuer_preserve_old_pair_without_exchange(self):
        self.save()
        for options in ({'denied':True},{'wrong_issuer':True}):
            with patch.dict(os.environ, {'GOOGLE_WORKSPACE_MCP_CALLBACK_PORT':str(self.free_port())}), \
                 patch.object(auth, 'request_json', side_effect=self.fake_request) as request, \
                 patch.object(auth.webbrowser, 'open', side_effect=lambda url:self.browser(url,**options)):
                code,out,err=self.main('login');self.thread.join(5)
            self.assertEqual(code,1)
            self.assertNotIn(BASE+'/token',[call.args[1] for call in request.call_args_list])
            self.assertEqual(self.read(),self.grant)

    def test_occupied_port_does_not_register_or_open_browser(self):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0));sock.listen()
            with patch.dict(os.environ, {'GOOGLE_WORKSPACE_MCP_CALLBACK_PORT':str(sock.getsockname()[1])}), \
                 patch.object(auth, 'request_json', side_effect=self.fake_request) as request, \
                 patch.object(auth.webbrowser, 'open') as browser:
                self.assertEqual(self.main('login')[0],1)
        browser.assert_not_called()
        self.assertEqual(len(request.call_args_list),2)

    def test_login_timeout_browser_error_and_exchange_failure_keep_old_pair(self):
        self.save()
        with patch.dict(os.environ, {'GOOGLE_WORKSPACE_MCP_CALLBACK_PORT':str(self.free_port())}), \
             patch.object(auth, 'request_json', side_effect=self.fake_request), \
             patch.object(auth.webbrowser, 'open', side_effect=OSError('browser-private')), patch.object(auth,'LOGIN_TIMEOUT',0):
            code,out,err=self.main('login')
        self.assertEqual(code,1);self.assertNotIn('browser-private',err);self.assertEqual(self.read(),self.grant)
        def fail(resource,url,body=None,form=False):
            if url.endswith('/token'):raise auth.AuthError('Exchange rejected')
            return self.fake_request(resource,url,body,form)
        with patch.dict(os.environ, {'GOOGLE_WORKSPACE_MCP_CALLBACK_PORT':str(self.free_port())}), \
             patch.object(auth, 'request_json', side_effect=fail),patch.object(auth.webbrowser,'open',side_effect=self.browser):
            self.assertEqual(self.main('login')[0],1);self.thread.join(5)
        self.assertEqual(self.read(),self.grant)

    def test_logout_removes_only_new_local_pair_and_does_not_revoke(self):
        self.save()
        with patch.object(auth,'request_json',side_effect=AssertionError('no network')):
            self.assertEqual(self.main('logout')[0],0)
            self.assertEqual(self.main('logout')[0],0)
        self.assertIsNone(self.read())
        self.assertTrue((self.directory/'.lock').exists())

    def worker(self):
        process = subprocess.Popen([sys.executable, '-B', '-c', WORKER, str(HELPER), str(Path(self.temp.name) / 'refreshes')],
                                   env=dict(os.environ), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.cleanup_process, process)
        return process

    @staticmethod
    def cleanup_process(process):
        if process.poll() is None:process.kill()
        process.communicate(timeout=5)

    def test_concurrent_processes_refresh_once_and_reload_saved_state(self):
        self.tokens['expiresAt']=1;self.save()
        processes=[self.worker(),self.worker()]
        for process in processes:
            out,err=process.communicate(timeout=10)
            self.assertEqual((process.returncode,out),(0,'new-access\n'),err)
        self.assertEqual((Path(self.temp.name)/'refreshes').read_text(),'refresh\n')
        self.assertEqual(self.read()['tokens']['refreshToken'],'new-refresh')

    def test_logout_waits_for_refresh_and_is_not_resurrected(self):
        self.tokens['expiresAt']=1;self.save()
        process=self.worker();self.assertEqual(process.stderr.readline(),'refreshing\n')
        result=subprocess.run([sys.executable,'-B',str(HELPER),'logout'],env=dict(os.environ),capture_output=True,timeout=10)
        process.communicate(timeout=10)
        self.assertEqual((result.returncode,process.returncode),(0,0))
        self.assertIsNone(self.read())

    def test_lock_timeout_and_process_death_release(self):
        self.save()
        process=subprocess.Popen([sys.executable,'-B','-c',
            'import fcntl,sys,time; f=open(sys.argv[1],"r+"); fcntl.flock(f,fcntl.LOCK_EX); print("locked",flush=True); time.sleep(30)',
            str(self.directory/'.lock')],env=dict(os.environ),stdout=subprocess.PIPE,text=True)
        self.addCleanup(self.cleanup_process,process)
        self.assertEqual(process.stdout.readline(),'locked\n')
        with patch.object(auth,'LOCK_TIMEOUT',0.05):
            code,out,err=self.main('token')
        self.assertEqual((code,out),(1,''));self.assertIn('busy',err)
        process.kill();process.wait(timeout=5)
        self.assertEqual(self.main('token'),(0,'old-access\n',''))

    def test_login_reuses_compatible_client(self):
        port=self.free_port();self.client['redirectUri']=f'http://127.0.0.1:{port}/callback';self.save()
        with patch.dict(os.environ,{'GOOGLE_WORKSPACE_MCP_CALLBACK_PORT':str(port)}), \
             patch.object(auth,'request_json',side_effect=self.fake_request) as request, \
             patch.object(auth.webbrowser,'open',side_effect=self.browser):
            code,out,err=self.main('login');self.thread.join(5)
        self.assertEqual(code,0,err)
        self.assertNotIn(BASE+'/register',[call.args[1] for call in request.call_args_list])
        self.assertEqual(self.read()['client']['clientId'],'test-client')

    def test_failed_login_save_keeps_old_client_and_tokens_together(self):
        self.save()
        with patch.dict(os.environ,{'GOOGLE_WORKSPACE_MCP_CALLBACK_PORT':str(self.free_port())}), \
             patch.object(auth,'request_json',side_effect=self.fake_request), \
             patch.object(auth.webbrowser,'open',side_effect=self.browser), \
             patch.object(auth.os,'replace',side_effect=OSError('private-detail')):
            code,out,err=self.main('login');self.thread.join(5)
        self.assertEqual((code,out),(1,''));self.assertNotIn('private-detail',err)
        self.assertEqual(self.read(),self.grant)
        self.assertFalse(list(self.directory.glob('*.tmp')))

    def test_callback_cancellation_propagates_and_never_exchanges(self):
        self.save()
        for signum in (signal.SIGTERM,signal.SIGALRM):
            request_socket,peer=socket.socketpair()
            with request_socket,peer,patch.dict(os.environ,{'GOOGLE_WORKSPACE_MCP_CALLBACK_PORT':str(self.free_port())}), \
                 patch.object(auth,'request_json',side_effect=self.fake_request) as request, \
                 patch.object(auth.webbrowser,'open',return_value=True), \
                 patch.object(auth.CallbackServer,'handle_request',auth.CallbackServer._handle_request_noblock), \
                 patch.object(auth.CallbackServer,'get_request',return_value=(request_socket,('127.0.0.1',1))), \
                 patch.object(auth.CallbackServer,'finish_request',side_effect=lambda *_:auth.interrupt(signum,None)):
                code,out,err=self.main('login')
            self.assertEqual((code,out),(1,''));self.assertIn('interrupted',err);self.assertNotIn('Traceback',err)
            self.assertNotIn(BASE+'/token',[call.args[1] for call in request.call_args_list])
            self.assertEqual(self.read(),self.grant)

    def test_http_bad_success_bodies_and_network_errors_are_sanitized(self):
        class Response:
            def __init__(self,data):self.data=data
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,n):return self.data
        for body in (b'[]',b'not json',b'\xff',b'x'*(auth.MAX_JSON_BYTES+1),b'{"error":"private-detail"}'):
            opener=types.SimpleNamespace(open=lambda *args,**kwargs:Response(body))
            with patch.object(auth.urllib.request,'build_opener',return_value=opener),self.assertRaises(auth.AuthError) as failure:
                REAL_REQUEST(RESOURCE,BASE+'/token')
            self.assertNotIn('private-detail',str(failure.exception))
        for error in (OSError('private-detail'),http.client.IncompleteRead(b'private-detail')):
            opener=types.SimpleNamespace(open=lambda *args,**kwargs:(_ for _ in ()).throw(error))
            with patch.object(auth.urllib.request,'build_opener',return_value=opener),self.assertRaises(auth.AuthError) as failure:
                REAL_REQUEST(RESOURCE,BASE+'/token')
            self.assertNotIn('private-detail',str(failure.exception))

    def test_help_and_invalid_refresh_do_not_touch_store(self):
        for args in (['--help'],['login','--refresh']):
            result=subprocess.run([sys.executable,'-B',str(HELPER),*args],capture_output=True,env=dict(os.environ))
            self.assertEqual(result.returncode,0 if args==['--help'] else 2)
        self.assertFalse(self.directory.exists())


if __name__ == '__main__':
    unittest.main()
