"""Native macOS Keychain storage for host-side MCP authentication helpers."""

import contextlib
import ctypes
import hashlib
import os
import re
import sys

MAX_JSON_BYTES = 65_536


class AuthError(Exception):
    pass


def reject_orphaned_credentials(directory, prefix):
    # A first save may have crashed before the old writer renamed its temp file.
    # Do not assume this uncommitted grant is valid, or silently leave it behind.
    if any(re.fullmatch(re.escape(prefix) + r'\.[a-z0-9_]{8}\.tmp', path.name)
           for path in directory.glob(prefix + '.*.tmp')):
        raise AuthError('Uncommitted plaintext credentials remain from an interrupted save; run this host helper with logout to discard them before signing in again.')


class Keychain:
    """Generic password in the host's default Keychain; no secrets in argv/files."""

    NOT_FOUND = -25300
    SERVICE = None  # Each host helper supplies its own Keychain namespace.

    def __init__(self, directory):
        if sys.platform != 'darwin':
            raise AuthError('MCP credentials require the macOS host Keychain. Use the host credential proxy from sandboxes and VMs.')
        if not isinstance(self.SERVICE, bytes) or not self.SERVICE:
            raise AuthError('A Keychain service name is required.')
        self.account = hashlib.sha256(os.fsencode(directory.resolve())).hexdigest().encode()
        self.security = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
        self.core = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
        pointer = ctypes.c_void_p
        uint = ctypes.c_uint32
        signatures = {
            'SecKeychainSetUserInteractionAllowed': [ctypes.c_ubyte],
            'SecKeychainCopyDefault': [ctypes.POINTER(pointer)],
            'SecKeychainFindGenericPassword': [pointer, uint, pointer, uint, pointer,
                                               ctypes.POINTER(uint), ctypes.POINTER(pointer), ctypes.POINTER(pointer)],
            'SecKeychainAddGenericPassword': [pointer, uint, pointer, uint, pointer, uint, pointer, ctypes.POINTER(pointer)],
            'SecKeychainItemModifyAttributesAndData': [pointer, pointer, uint, pointer],
            'SecKeychainItemDelete': [pointer],
            'SecKeychainItemFreeContent': [pointer, pointer],
        }
        for name, args in signatures.items():
            function = getattr(self.security, name)
            function.argtypes = args
            function.restype = ctypes.c_int32
        self.core.CFRelease.argtypes = [pointer]
        self.core.CFRelease.restype = None
        # Proxy capture commands must not hang waiting for a GUI prompt.
        self.check(self.security.SecKeychainSetUserInteractionAllowed(False))

    @staticmethod
    def check(status):
        if status:
            raise AuthError(f'macOS Keychain operation failed (OSStatus {status}); unlock the host Keychain and check helper access. No plaintext fallback.')

    @contextlib.contextmanager
    def opened(self):
        keychain = ctypes.c_void_p()
        self.check(self.security.SecKeychainCopyDefault(ctypes.byref(keychain)))
        try:
            yield keychain
        finally:
            self.core.CFRelease(keychain)

    def find(self, keychain, length=None, data=None, item=None):
        return self.security.SecKeychainFindGenericPassword(
            keychain, len(self.SERVICE), self.SERVICE, len(self.account), self.account,
            length, data, item,
        )

    def read(self):
        with self.opened() as keychain:
            length, data = ctypes.c_uint32(), ctypes.c_void_p()
            status = self.find(keychain, ctypes.byref(length), ctypes.byref(data))
            if status == self.NOT_FOUND:
                return None
            self.check(status)
            try:
                if length.value > MAX_JSON_BYTES:
                    raise AuthError('Keychain credential is too large.')
                return ctypes.string_at(data, length.value)
            finally:
                self.security.SecKeychainItemFreeContent(None, data)

    def write(self, raw):
        with self.opened() as keychain:
            item = ctypes.c_void_p()
            status = self.find(keychain, item=ctypes.byref(item))
            if status == self.NOT_FOUND:
                self.check(self.security.SecKeychainAddGenericPassword(
                    keychain, len(self.SERVICE), self.SERVICE, len(self.account), self.account, len(raw), raw, None,
                ))
            else:
                self.check(status)
                try:
                    self.check(self.security.SecKeychainItemModifyAttributesAndData(item, None, len(raw), raw))
                finally:
                    self.core.CFRelease(item)

    def delete(self):
        with self.opened() as keychain:
            item = ctypes.c_void_p()
            status = self.find(keychain, item=ctypes.byref(item))
            if status == self.NOT_FOUND:
                return
            self.check(status)
            try:
                self.check(self.security.SecKeychainItemDelete(item))
            finally:
                self.core.CFRelease(item)

