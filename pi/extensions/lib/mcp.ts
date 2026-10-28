/** Shared confirmation and classification for native MCP tools. */
import type {ExtensionAPI, ToolInfo} from '@earendil-works/pi-coding-agent';

import {queueDialog} from './dialog.js';

type McpPermissionTool = Pick<ToolInfo, 'name' | 'annotations'>;

export function queueMcpConfirmation(
  ui: object,
  prompt: () => Promise<boolean>,
  signal?: AbortSignal,
): Promise<boolean> {
  return queueDialog(ui, prompt, signal)
    .then((approved) => approved === true && !signal?.aborted, () => false);
}

export function registerMcpPermissionGate(
  pi: ExtensionAPI,
  opts: {
    server: string;
    label: string;
    isWriteTool(tool: McpPermissionTool): boolean;
  },
): void {
  const prefix = `mcp__${opts.server}__`;
  pi.on('tool_call', async (event, ctx) => {
    if (!event.toolName.startsWith(prefix)) {
      return;
    }
    const tool = pi.getAllTools().find(({name}) => name === event.toolName);
    if (tool && !opts.isWriteTool(tool)) {
      return;
    }
    const blocked = {
      block: true,
      reason:
        `${opts.label} tool ${event.toolName} requires per-call user confirmation.`,
    };
    if (!ctx.hasUI) {
      return blocked;
    }
    const signal = ctx.signal;
    try {
      const approved = await queueMcpConfirmation(ctx.ui, () =>
        ctx.ui.confirm(
          `${opts.label} write operation`,
          `Allow ${event.toolName}?\n\n${JSON.stringify(event.input, null, 2)}`,
          {signal},
        ), signal);
      return approved && !signal?.aborted ? undefined : blocked;
    } catch {
      return blocked;
    }
  });
}

// Only explicitly read-only tools can bypass confirmation. Destructive hints
// and mutation verbs override readOnlyHint, including in camelCase/PascalCase
// names. Unknown or unannotated operations fail closed: an extra prompt is
// preferable to an unconfirmed mutation.
export function makeIsWriteTool(
  verbs: Set<string>,
): (tool: McpPermissionTool) => boolean {
  return (tool: McpPermissionTool): boolean => {
    if (
      tool.annotations?.readOnlyHint !== true ||
      tool.annotations?.destructiveHint === true
    ) {
      return true;
    }
    const tokens = tool.name
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .split(/[^a-z0-9]+/);
    return tokens.some((token) => verbs.has(token));
  };
}
