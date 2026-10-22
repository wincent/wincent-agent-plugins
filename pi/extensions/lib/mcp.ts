/** Shared confirmation and classification for native MCP tools. */
import type {ToolInfo} from '@earendil-works/pi-coding-agent';

type McpPermissionTool = Pick<ToolInfo, 'name' | 'annotations'>;

// Pi loads extensions with separate module caches. Share queues per UI even
// across those module instances, without retaining retired UI objects.
const confirmationQueuesKey = Symbol.for(
  'wincent-agent-plugins.mcp-confirmations',
);
const confirmationState = globalThis as typeof globalThis & {
  [confirmationQueuesKey]?: WeakMap<object, Promise<void>>;
};
const confirmationQueues = confirmationState[confirmationQueuesKey] ??=
  new WeakMap<object, Promise<void>>();

export function queueMcpConfirmation(
  ui: object,
  prompt: () => Promise<boolean>,
): Promise<boolean> {
  const result = (confirmationQueues.get(ui) ?? Promise.resolve())
    .then(prompt)
    .then((approved) => approved === true, () => false);
  confirmationQueues.set(ui, result.then(() => {}));
  return result;
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
