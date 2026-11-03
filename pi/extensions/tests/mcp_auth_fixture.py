"""Synthetic-only credential store shared by host MCP auth test subprocesses."""

import contextlib
import importlib.machinery
import io
import os
from pathlib import Path
import sys
import types
import urllib.parse
from unittest import mock


class FakeKeychain:
    def __init__(self, directory):
        self.path = directory / 'test-keychain'

    def read(self):
        try:
            return self.path.read_bytes()
        except FileNotFoundError:
            return None

    def write(self, raw):
        temporary = self.path.with_suffix('.tmp')
        with temporary.open('wb') as file:
            os.chmod(temporary, 0o600)
            file.write(raw)
        os.replace(temporary, self.path)

    def delete(self):
        self.path.unlink(missing_ok=True)


def load_auth(script, *, fake_keychain=True):
    sys.path.insert(0, str(Path(script).parent))
    module = types.ModuleType('mcp_auth')
    importlib.machinery.SourceFileLoader(module.__name__, str(script)).exec_module(module)
    if fake_keychain:
        module.Keychain = FakeKeychain
    return module


@contextlib.contextmanager
def simulated_callback(auth):
    """Exercise login persistence without opening a real listening socket."""
    server = mock.MagicMock()
    server.__enter__.return_value = server
    with mock.patch.object(auth, 'CallbackServer', return_value=server) as factory:
        def open_browser(url):
            params = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
            handler_class = factory.call_args.args[1]
            handler = object.__new__(handler_class)
            handler.path = '/callback?' + urllib.parse.urlencode({'state': params['state'][0], 'code': 'synthetic-code'})
            handler.send_response = mock.Mock()
            handler.send_header = mock.Mock()
            handler.end_headers = mock.Mock()
            handler.wfile = io.BytesIO()
            server.handle_request.side_effect = handler.do_GET
            return True
        with mock.patch.object(auth.webbrowser, 'open', side_effect=open_browser):
            yield
