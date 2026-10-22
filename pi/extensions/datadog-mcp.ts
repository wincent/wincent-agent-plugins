/** Per-call write confirmation for the native MCP server named `datadog`. */
import {type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {makeIsWriteTool} from './lib/mcp.js';

const isWriteTool = makeIsWriteTool(
  new Set([
    'add',
    'archive',
    'assign',
    'cancel',
    'create',
    'delete',
    'detach',
    'disable',
    'edit',
    'enable',
    'escalate',
    'execute',
    'manage',
    'mitigate',
    'mute',
    'override',
    'patch',
    'post',
    'publish',
    'put',
    'recover',
    'remove',
    'rename',
    'reorder',
    'resolve',
    'retry',
    'run',
    'schedule',
    'send',
    'set',
    'submit',
    'swap',
    'trigger',
    'unblock',
    'unmute',
    'unpublish',
    'update',
    'upsert',
    'write',
  ]),
);

export default function datadogMcp(pi: ExtensionAPI) {
  // Parallel codemode calls must not replace one another's dialogs.
  let confirmation = Promise.resolve();

  pi.on('tool_call', async (event, ctx) => {
    if (!event.toolName.startsWith('mcp__datadog__')) {
      return;
    }
    const tool = pi.getAllTools().find(({name}) => name === event.toolName);
    if (tool && !isWriteTool(tool)) {
      return;
    }
    const blocked = {
      block: true,
      reason:
        `Datadog tool ${event.toolName} requires per-call user confirmation.`,
    };
    if (!ctx.hasUI) {
      return blocked;
    }
    const pending = confirmation.then(async () => {
      try {
        const approved = await ctx.ui.confirm(
          'Datadog write operation',
          `Allow ${event.toolName}?\n\n${JSON.stringify(event.input, null, 2)}`,
        );
        return approved ? undefined : blocked;
      } catch {
        return blocked;
      }
    });
    confirmation = pending.then(() => {});
    return pending;
  });
}
