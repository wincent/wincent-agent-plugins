/** Per-call write confirmation for the native MCP server named `datadog`. */
import {type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {makeIsWriteTool, registerMcpPermissionGate} from './lib/mcp.js';

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
  registerMcpPermissionGate(pi, {
    server: 'datadog',
    label: 'Datadog',
    isWriteTool,
  });
}
