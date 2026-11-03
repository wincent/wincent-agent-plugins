"""Synthetic-only credential store shared by Slack auth test subprocesses."""

import importlib.machinery
import os
import types


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


def load_auth(script):
    module = types.ModuleType('slack_mcp_auth')
    importlib.machinery.SourceFileLoader(module.__name__, str(script)).exec_module(module)
    module.Keychain = FakeKeychain
    return module
