#!/usr/bin/env python3
"""
Convert a pi session JSONL file to Markdown.

Reads the JSONL, reconstructs the active branch (leaf to root), and renders
each entry as readable Markdown. Deterministic — no LLM involvement.

Usage:
    jsonl-to-markdown.py <session.jsonl>
    jsonl-to-markdown.py -              # read from stdin
"""

import json
import re
import sys
from datetime import datetime, timezone


def load_entries(source):
    """Load JSONL entries from a file path or stdin."""
    if source == "-":
        lines = sys.stdin.read().strip().split("\n")
    else:
        with open(source) as f:
            lines = f.read().strip().split("\n")
    return [json.loads(line) for line in lines if line.strip()]


def find_active_branch(entries):
    """Walk parentId links from leaf to root, return entries in root-to-leaf order."""
    header = None
    by_id = {}
    child_ids = set()

    for entry in entries:
        if entry.get("type") == "session":
            header = entry
            continue
        eid = entry.get("id")
        if eid:
            by_id[eid] = entry
        pid = entry.get("parentId")
        if pid:
            child_ids.add(pid)

    # Leaf: last entry whose id is never a parentId of any later entry.
    leaf = None
    for entry in reversed(entries):
        eid = entry.get("id")
        if eid and eid not in child_ids:
            leaf = entry
            break

    if not leaf:
        return header, [e for e in entries if e.get("type") != "session"]

    chain = []
    current = leaf
    while current:
        chain.append(current)
        pid = current.get("parentId")
        current = by_id.get(pid) if pid else None
    chain.reverse()

    return header, chain


def format_timestamp(ts):
    """Format an ISO timestamp or unix-ms timestamp to a readable string."""
    if isinstance(ts, (int, float)):
        dt = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
    elif isinstance(ts, str):
        try:
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            return ts
    else:
        return str(ts)
    return dt.strftime("%Y-%m-%d %H:%M:%S UTC")


def truncate(text, limit=500):
    """Truncate text to limit chars, appending an ellipsis marker if cut."""
    if len(text) <= limit:
        return text
    return text[:limit] + "\n... (truncated)"


DETAILS_LINE_THRESHOLD = 10


def fence(text, lang=""):
    """Wrap text in a fenced code block, choosing enough backticks to avoid conflicts."""
    max_run = 0
    for m in re.finditer(r"`{3,}", text):
        max_run = max(max_run, len(m.group()))
    ticks = "`" * max(max_run + 1, 3)
    return f"{ticks}{lang}\n{text}\n{ticks}"


def maybe_collapse(text, summary):
    """Wrap text in <details> if it exceeds the line threshold."""
    line_count = text.count("\n") + 1
    if line_count <= DETAILS_LINE_THRESHOLD:
        return text
    return (
        f"<details>\n<summary>{summary} ({line_count} lines)</summary>\n\n"
        + text
        + "\n\n</details>"
    )


def render_content_blocks(blocks):
    """Render a list of content blocks to Markdown."""
    parts = []
    for block in blocks:
        btype = block.get("type")
        if btype == "text":
            parts.append(block.get("text", ""))
        elif btype == "image":
            mime = block.get("mimeType", "image")
            parts.append(f"*[image: {mime}]*")
        elif btype == "thinking":
            thinking = block.get("thinking", "")
            if thinking.strip():
                parts.append(
                    "<details>\n<summary>Thinking</summary>\n\n"
                    + thinking
                    + "\n\n</details>"
                )
        elif btype == "toolCall":
            name = block.get("name", "unknown")
            args = block.get("arguments", {})
            formatted = json.dumps(args, indent=2)
            parts.append(
                f"**Tool call: `{name}`**\n\n"
                f"```json\n{truncate(formatted, 2000)}\n```"
            )
    return "\n\n".join(parts)


def render_message(msg):
    """Render a single AgentMessage to Markdown."""
    role = msg.get("role", "unknown")
    content = msg.get("content", "")

    if role == "user":
        if isinstance(content, str):
            body = content
        elif isinstance(content, list):
            body = render_content_blocks(content)
        else:
            body = str(content)
        return f"## User\n\n{body}"

    if role == "assistant":
        blocks = content if isinstance(content, list) else []
        body = render_content_blocks(blocks)
        model = msg.get("model", "")
        provider = msg.get("provider", "")
        usage = msg.get("usage", {})
        cost = usage.get("cost", {})
        total_cost = cost.get("total", 0)

        header = "## Assistant"
        if model:
            header += f" ({provider}/{model})" if provider else f" ({model})"
        if total_cost:
            header += f" — ${total_cost:.4f}"

        return f"{header}\n\n{body}"

    if role == "toolResult":
        tool_name = msg.get("toolName", "unknown")
        is_error = msg.get("isError", False)
        blocks = content if isinstance(content, list) else []
        text_parts = []
        for block in blocks:
            if block.get("type") == "text":
                text_parts.append(block.get("text", ""))
            elif block.get("type") == "image":
                text_parts.append(f"[image: {block.get('mimeType', 'image')}]")
        body = "\n".join(text_parts)
        error_marker = " **ERROR**" if is_error else ""
        fenced = fence(body)
        collapsed = maybe_collapse(fenced, f"Tool result: `{tool_name}`")
        return f"### Tool result: `{tool_name}`{error_marker}\n\n{collapsed}"

    if role == "bashExecution":
        cmd = msg.get("command", "")
        output = msg.get("output", "")
        exit_code = msg.get("exitCode")
        cancelled = msg.get("cancelled", False)
        truncated = msg.get("truncated", False)

        parts = [f"### Shell\n\n```\n$ {cmd}\n```"]
        if output.strip():
            parts.append(f"```\n{truncate(output, 5000)}\n```")
        notes = []
        if exit_code is not None and exit_code != 0:
            notes.append(f"exit code {exit_code}")
        if cancelled:
            notes.append("cancelled")
        if truncated:
            notes.append("output truncated")
        if notes:
            parts.append(f"*({', '.join(notes)})*")
        return "\n\n".join(parts)

    if role == "custom":
        custom_type = msg.get("customType", "")
        if isinstance(content, str):
            body = content
        elif isinstance(content, list):
            body = render_content_blocks(content)
        else:
            body = str(content)
        return f"### Extension ({custom_type})\n\n{body}"

    if role == "compactionSummary":
        summary = msg.get("summary", "")
        return f"---\n\n*Context compacted.*\n\n{summary}\n\n---"

    if role == "branchSummary":
        summary = msg.get("summary", "")
        return f"---\n\n*Branch summary:*\n\n{summary}\n\n---"

    return f"### {role}\n\n{str(content)[:500]}"


def render_entry(entry):
    """Render a session entry to Markdown, or None to skip."""
    etype = entry.get("type")

    if etype == "message":
        return render_message(entry.get("message", {}))

    if etype == "model_change":
        provider = entry.get("provider", "")
        model = entry.get("modelId", "")
        return f"*Switched to {provider}/{model}.*"

    if etype == "thinking_level_change":
        level = entry.get("thinkingLevel", "")
        return f"*Thinking level: {level}.*"

    if etype == "compaction":
        summary = entry.get("summary", "")
        tokens = entry.get("tokensBefore", 0)
        return (
            f"---\n\n*Context compacted (was {tokens:,} tokens).*\n\n"
            f"{summary}\n\n---"
        )

    if etype == "branch_summary":
        summary = entry.get("summary", "")
        return f"---\n\n*Branch summary:*\n\n{summary}\n\n---"

    # Skip: session, label, session_info, custom (non-message), etc.
    return None


def compute_totals(entries):
    """Sum up cost and token usage across all assistant messages on the branch."""
    total_cost = 0.0
    total_input = 0
    total_output = 0

    for entry in entries:
        if entry.get("type") != "message":
            continue
        msg = entry.get("message", {})
        if msg.get("role") != "assistant":
            continue
        usage = msg.get("usage", {})
        cost = usage.get("cost", {})
        total_cost += cost.get("total", 0)
        total_input += usage.get("input", 0)
        total_output += usage.get("output", 0)

    return total_cost, total_input, total_output


def main():
    if len(sys.argv) < 2:
        print(
            "Usage: jsonl-to-markdown.py <session.jsonl | -> [summary-file]",
            file=sys.stderr,
        )
        sys.exit(1)

    entries = load_entries(sys.argv[1])
    summary_file = sys.argv[2] if len(sys.argv) > 2 else None
    header, branch = find_active_branch(entries)

    # Title
    parts = ["# Pi Session"]

    # Metadata
    meta = []
    if header:
        ts = header.get("timestamp", "")
        if ts:
            meta.append(f"- **Date**: {format_timestamp(ts)}")
        cwd = header.get("cwd", "")
        if cwd:
            meta.append(f"- **Working directory**: `{cwd}`")
        sid = header.get("id", "")
        if sid:
            meta.append(f"- **Session**: `{sid}`")

    total_cost, total_input, total_output = compute_totals(branch)
    if total_cost:
        meta.append(f"- **Total cost**: ${total_cost:.4f}")
    if total_input or total_output:
        meta.append(
            f"- **Tokens**: {total_input:,} input, {total_output:,} output"
        )

    if meta:
        parts.append("\n".join(meta))

    if summary_file:
        with open(summary_file) as f:
            summary = f.read().strip()
        if summary:
            parts.append("## Summary\n\n" + summary)

    parts.append("---")

    # Entries
    for entry in branch:
        rendered = render_entry(entry)
        if rendered is not None:
            parts.append(rendered)

    print("\n\n".join(parts))


if __name__ == "__main__":
    main()
