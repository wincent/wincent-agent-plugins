import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'pi/extensions/bin'))
import mcp_auth_status


class JsonOutputTest(unittest.TestCase):
    def test_status_uses_jq_when_available(self):
        with mock.patch.object(mcp_auth_status.shutil, 'which', return_value='/test/jq') as which, \
             mock.patch.object(mcp_auth_status.subprocess, 'run') as run, contextlib.redirect_stdout(io.StringIO()) as out:
            run.return_value.stdout = '{\n  "state": "not_signed_in"\n}\n'
            mcp_auth_status.print_status({'state': 'not_signed_in'})
        which.assert_called_once_with('jq')
        self.assertEqual(run.call_args.args[0], ['/test/jq', '.'])
        self.assertEqual(json.loads(run.call_args.kwargs['input']), {'state': 'not_signed_in'})
        self.assertEqual(out.getvalue(), run.return_value.stdout)

    def test_status_without_jq_keeps_raw_json(self):
        with mock.patch.object(mcp_auth_status.shutil, 'which', return_value=None), \
             mock.patch.object(mcp_auth_status.subprocess, 'run') as run, contextlib.redirect_stdout(io.StringIO()) as out:
            mcp_auth_status.print_status({'state': 'not_signed_in'})
        run.assert_not_called()
        self.assertEqual(out.getvalue(), '{"state": "not_signed_in"}\n')


class AuthCliTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='auth-cli-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.script = self.root / 'test checkout' / 'bin/auth'
        self.script.parent.mkdir(parents=True)
        shutil.copy2(ROOT / 'bin/auth', self.script)
        self.helpers = self.script.parents[1] / 'pi/extensions/bin'
        self.helpers.mkdir(parents=True)
        self.env = {'PATH': os.environ['PATH'], 'TZ': 'UTC0'}

    def helper(self, name, body):
        path = self.helpers / name
        path.write_text('#!/bin/sh\nset -eu\n' + body + '\n')
        path.chmod(0o700)

    def cli(self, *args):
        return subprocess.run([sys.executable, '-B', self.script, *args], cwd=self.root,
                              env=self.env, capture_output=True, text=True, timeout=10)

    def test_status_summarizes_all_services_and_suggests_next_steps(self):
        self.helper('datadog-mcp-auth', '''
test "$*" = status
echo '{"state":"access_token_valid","expires_at_ms":1795429458636.29,"refresh_token_present":true,"client_registered":true}'
''')
        self.helper('google-workspace-mcp-auth', '''
test "$*" = status
echo '{"state":"expired","expires_at_ms":1704067200000,"refresh_token_present":true,"refresh_validity":"not_checked"}'
''')
        self.helper('slack-mcp-auth', '''
test "$*" = status
echo '{"state":"not_signed_in"}'
''')
        result = self.cli('status')
        self.assertEqual(result.returncode, 0, result.stderr)
        datadog, google, slack = result.stdout.splitlines()
        self.assertRegex(datadog, r'^Datadog: access token expires 2026-11-23 \d\d:\d\d:\d\d UTC\.$')
        self.assertIn('Google Workspace: access token expired 2024-01-01 00:00:00 UTC', google)
        self.assertIn('Refresh not checked.', google)
        self.assertIn('refresh google; if rejected', google)
        self.assertIn('login google', google)
        self.assertIn('Slack: not signed in.', slack)
        self.assertTrue(slack.endswith('login slack'))

    def test_status_for_one_service_with_no_way_to_refresh(self):
        self.helper('datadog-mcp-auth', '''
test "$*" = status
echo '{"state":"expired","expires_at_ms":1704067200000,"refresh_token_present":true,"client_registered":false}'
''')
        result = self.cli('status', 'datadog')
        self.assertEqual(result.returncode, 0)
        self.assertIn('Missing client registration', result.stdout)
        self.assertTrue(result.stdout.rstrip().endswith('login datadog'))
        self.assertEqual(len(result.stdout.splitlines()), 1)

    def test_status_reports_errors_and_continues_with_other_services(self):
        self.helper('datadog-mcp-auth', 'echo malformed')
        self.helper('google-workspace-mcp-auth', '''
echo 'google-workspace-mcp-auth: Set GOOGLE_WORKSPACE_MCP_URL.' >&2
exit 1
''')
        self.helper('slack-mcp-auth', """echo '{"state":"not_signed_in"}'""")
        result = self.cli('status')
        self.assertEqual(result.returncode, 1)
        self.assertIn('Datadog: could not check status: unexpected status output', result.stdout)
        self.assertIn('Google Workspace: could not check status: Set GOOGLE_WORKSPACE_MCP_URL.', result.stdout)
        self.assertIn('Slack: not signed in.', result.stdout)

    def test_dispatch_preserves_exit_status_and_never_displays_refresh_token_output(self):
        self.helper('slack-mcp-auth', '''
case "$*" in
    login) echo 'browser started' >&2 ;;
    logout) exit 7 ;;
    'token --refresh') echo 'synthetic-access-token' ;;
    *) exit 99 ;;
esac
''')
        result = self.cli('login', 'slack')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, 'browser started\n')
        self.assertEqual(self.cli('logout', 'slack').returncode, 7)
        result = self.cli('refresh', 'slack')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'Slack: access token refreshed.\n')
