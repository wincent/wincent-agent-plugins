/** Per-call write confirmation for the native MCP server named `slack`. */
import {type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {makeIsWriteTool, queueMcpConfirmation} from './lib/mcp.js';

const isWriteTool = makeIsWriteTool(
  new Set([
    'acknowledge',
    'add',
    'archive',
    'bookmark',
    'close',
    'complete',
    'create',
    'delete',
    'draft',
    'edit',
    'end',
    'invite',
    'join',
    'kick',
    'leave',
    'open',
    'pin',
    'post',
    'react',
    'remove',
    'rename',
    'reopen',
    'reply',
    'revoke',
    'schedule',
    'send',
    'set',
    'share',
    'star',
    'start',
    'stop',
    'unarchive',
    'unbookmark',
    'unpin',
    'unschedule',
    'unstar',
    'update',
    'upload',
    'write',
  ]),
);

export default function slackMcp(pi: ExtensionAPI) {
  pi.on('tool_call', async (event, ctx) => {
    if (!event.toolName.startsWith('mcp__slack__')) {
      return;
    }
    const tool = pi.getAllTools().find(({name}) => name === event.toolName);
    if (tool && !isWriteTool(tool)) {
      return;
    }
    const blocked = {
      block: true,
      reason:
        `Slack tool ${event.toolName} requires per-call user confirmation.`,
    };
    if (!ctx.hasUI) {
      return blocked;
    }
    try {
      const approved = await queueMcpConfirmation(ctx.ui, () =>
        ctx.ui.confirm(
          'Slack write operation',
          `Allow ${event.toolName}?\n\n${JSON.stringify(event.input, null, 2)}`,
        ));
      return approved ? undefined : blocked;
    } catch {
      return blocked;
    }
  });
}
