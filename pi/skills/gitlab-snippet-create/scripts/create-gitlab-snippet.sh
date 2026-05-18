#!/bin/sh
#
# Create a GitLab snippet from a Markdown file or stdin, or write to a local
# file if GitLab credentials are not available.
#
# Usage:
#   create-gitlab-snippet.sh <file.md> [title]
#   cat session.md | create-gitlab-snippet.sh - [title]
#
# When GITLAB_HOST and GITLAB_TOKEN are set, uploads to GitLab and prints the
# snippet URL. Otherwise, writes to a local file and prints the path.
#
# Optional: set OUTPUT_DIR to control where the local file is written
# (defaults to $TMPDIR, falling back to /tmp).

set -e

INPUT="$1"
TITLE="${2:-Pi Session - $(date '+%Y-%m-%d %H:%M')}"

if [ -z "$INPUT" ]; then
    echo "Usage: create-gitlab-snippet.sh <file|-> [title]" >&2
    exit 1
fi

if [ "$INPUT" = "-" ]; then
    FILE=$(mktemp)
    cat > "$FILE"
    CLEANUP=1
elif [ -f "$INPUT" ]; then
    FILE="$INPUT"
    CLEANUP=0
else
    echo "Error: file not found: $INPUT" >&2
    exit 1
fi

if [ -n "$GITLAB_HOST" ] && [ -n "$GITLAB_TOKEN" ]; then
    PAYLOAD=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    content = f.read()
payload = {
    'title': sys.argv[2],
    'visibility': 'internal',
    'files': [{'file_path': 'session.md', 'content': content}]
}
print(json.dumps(payload))
" "$FILE" "$TITLE")

    [ "$CLEANUP" = 1 ] && rm -f "$FILE"

    RESPONSE=$(curl -sS --max-time 30 \
        -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
        -H "Content-Type: application/json" \
        -d "$PAYLOAD" \
        "$GITLAB_HOST/api/v4/snippets")

    URL=$(echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('web_url', ''))" 2>/dev/null)

    if [ -n "$URL" ]; then
        echo "$URL"
    else
        echo "Error creating snippet:" >&2
        echo "$RESPONSE" >&2
        exit 1
    fi
else
    OUT_DIR="${OUTPUT_DIR:-${TMPDIR:-/tmp}}"
    SLUG=$(echo "$TITLE" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9-' | head -c 60)
    OUT_FILE="${OUT_DIR}/${SLUG}-$(date '+%Y%m%d-%H%M%S').md"

    if [ "$CLEANUP" = 1 ]; then
        mv "$FILE" "$OUT_FILE"
    else
        cp "$FILE" "$OUT_FILE"
    fi

    echo "$OUT_FILE"
fi
