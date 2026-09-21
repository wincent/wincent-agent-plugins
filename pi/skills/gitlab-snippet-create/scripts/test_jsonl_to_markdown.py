"""Run with python3 -m unittest discover -s pi/skills/gitlab-snippet-create/scripts."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest


SCRIPT = Path(__file__).with_name("jsonl-to-markdown.py")
SPEC = importlib.util.spec_from_file_location("jsonl_to_markdown", SCRIPT)
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)


def usage(cost, input_tokens=0, output_tokens=0):
    return {"cost": {"total": cost}, "input": input_tokens, "output": output_tokens}


class SessionExportTests(unittest.TestCase):
    def test_legacy_assistant_totals_are_unchanged(self):
        entries = [
            {"type": "message", "message": {"role": "user", "content": "Hi"}},
            {
                "type": "message",
                "message": {"role": "assistant", "usage": usage(0.5, 12, 3)},
            },
            {"type": "custom", "data": {"usage": usage(100)}},
        ]
        self.assertEqual(exporter.compute_totals(entries), (0.5, 12, 3))

    def test_warming_and_unknown_usage_kinds_contribute_to_totals(self):
        entries = [
            {
                "type": "message",
                "message": {"role": "assistant", "usage": usage(0.5, 12, 3)},
            },
            {"type": "usage", "kind": "cache_warm", "usage": usage(0.125, 0, 1)},
            {"type": "usage", "kind": "future_operation", "usage": usage(0.25, 5, 2)},
        ]
        self.assertEqual(exporter.compute_totals(entries), (0.875, 17, 6))

    def test_usage_only_and_missing_optional_usage_fields(self):
        self.assertEqual(
            exporter.compute_totals([
                {"type": "usage", "usage": {"cost": {"total": 0.25}}},
                {"type": "usage"},
                {"type": "usage", "usage": {}},
            ]),
            (0.25, 0, 0),
        )

    def test_system_prompt_and_tool_records_are_not_exported(self):
        messages = [
            {"role": "system", "content": "private instructions"},
            {"role": "system", "content": [{"type": "text", "text": "private"}]},
            {
                "role": "system",
                "content": "",
                "sections": {"preamble": "private instructions", "removed": None},
                "toolsAdded": [{"name": "private_tool", "parameters": {}}],
                "toolsRemoved": [{"name": "old_tool"}],
            },
        ]
        for message in messages:
            with self.subTest(message=message):
                self.assertIsNone(exporter.render_entry({"type": "message", "message": message}))

    def test_usage_is_accounted_for_but_not_rendered_as_conversation(self):
        self.assertIsNone(exporter.render_entry({
            "type": "usage", "kind": "cache_warm", "usage": usage(0.25),
        }))

    def test_branch_reconstruction_excludes_abandoned_usage(self):
        entries = [
            {"type": "session", "id": "session"},
            {
                "type": "message", "id": "user", "parentId": None,
                "message": {"role": "user", "content": "Hi"},
            },
            {
                "type": "usage", "id": "abandoned", "parentId": "user",
                "kind": "cache_warm", "usage": usage(100),
            },
            {
                "type": "message", "id": "reply", "parentId": "user",
                "message": {"role": "assistant", "usage": usage(0.5, 12, 3)},
            },
            {
                "type": "usage", "id": "warm", "parentId": "reply",
                "kind": "cache_warm", "usage": usage(0.25, 0, 1),
            },
        ]
        _, branch = exporter.find_active_branch(entries)
        self.assertEqual([entry["id"] for entry in branch], ["user", "reply", "warm"])
        self.assertEqual(exporter.compute_totals(branch), (0.75, 12, 4))

    def test_cli_exports_conversation_and_combined_totals(self):
        entries = [
            {"type": "session", "id": "session", "version": 3},
            {
                "type": "message", "id": "system", "parentId": None,
                "message": {
                    "role": "system", "content": "",
                    "sections": {"preamble": "PRIVATE_INSTRUCTIONS"},
                },
            },
            {
                "type": "message", "id": "user", "parentId": "system",
                "message": {"role": "user", "content": "Hi"},
            },
            {
                "type": "message", "id": "reply", "parentId": "user",
                "message": {
                    "role": "assistant", "model": "example", "provider": "test",
                    "content": [{"type": "text", "text": "Hello"}],
                    "usage": usage(0.5, 12, 3),
                },
            },
            {
                "type": "usage", "id": "warm", "parentId": "reply",
                "kind": "cache_warm", "usage": usage(0.25, 0, 1),
            },
        ]
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "-"],
            input="\n".join(json.dumps(entry) for entry in entries),
            capture_output=True, text=True, check=True,
        )
        self.assertIn("**Total cost**: $0.7500", result.stdout)
        self.assertIn("**Tokens**: 12 input, 4 output", result.stdout)
        self.assertIn("## User\n\nHi", result.stdout)
        self.assertIn("## Assistant (test/example) - $0.5000\n\nHello", result.stdout)
        self.assertNotIn("PRIVATE_INSTRUCTIONS", result.stdout)
        self.assertNotIn("### system", result.stdout)
        self.assertNotIn("cache_warm", result.stdout)


if __name__ == "__main__":
    unittest.main()
