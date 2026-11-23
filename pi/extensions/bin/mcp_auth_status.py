"""JSON output shared by the host-side MCP authentication helpers."""

import json
import shutil
import subprocess
import sys


def print_status(status):
    raw = json.dumps(status) + '\n'
    if jq := shutil.which('jq'):
        try:
            raw = subprocess.run([jq, '.'], input=raw, text=True, capture_output=True,
                                 check=True, timeout=5).stdout
        except (OSError, subprocess.SubprocessError):
            pass
    sys.stdout.write(raw)
