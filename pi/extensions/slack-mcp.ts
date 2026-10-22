/** Per-call write confirmation for the native MCP server named `slack`. */
import {type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {makeIsWriteTool, registerMcpPermissionGate} from './lib/mcp.js';

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
  registerMcpPermissionGate(pi, {
    server: 'slack',
    label: 'Slack',
    isWriteTool,
  });
}
