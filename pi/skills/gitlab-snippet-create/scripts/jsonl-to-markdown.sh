#!/bin/sh
#
# Convert a pi session JSONL file to Markdown.
#
# Usage:
#   jsonl-to-markdown.sh <session.jsonl> [summary-file]
#   jsonl-to-markdown.sh -              # read from stdin
#
# If summary-file is provided, its contents are inserted as a
# ## Summary section before the session transcript.
#
# Output goes to stdout.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

exec python3 "$SCRIPT_DIR/jsonl-to-markdown.py" "$@"
