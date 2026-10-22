/** Per-call write confirmation for the native MCP server named `google_workspace`. */
import {type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {queueMcpConfirmation} from './lib/mcp.js';

const TOOL_PREFIX = 'mcp__google_workspace__';
const READ_ONLY_TOOL_NAMES = new Set([
  'get_comment',
  'get_doc_as_markdown',
  'get_file_content',
  'get_file_metadata',
  'get_presentation',
  'get_slide',
  'get_slide_thumbnail',
  'get_spreadsheet_metadata',
  'list_file_comments',
  'list_folder_contents',
  'list_sheet_comments',
  'list_tabs',
  'ping',
  'read_document',
  'read_sheet',
  'search_files',
]);

export default function googleWorkspaceMcp(pi: ExtensionAPI) {
  pi.on('tool_call', async (event, ctx) => {
    if (!event.toolName.startsWith(TOOL_PREFIX)) {
      return;
    }
    const tool = pi.getAllTools().find(({name}) => name === event.toolName);
    if (
      tool &&
      READ_ONLY_TOOL_NAMES.has(event.toolName.slice(TOOL_PREFIX.length)) &&
      tool.annotations?.readOnlyHint !== false &&
      tool.annotations?.destructiveHint !== true
    ) {
      return;
    }
    const blocked = {
      block: true,
      reason:
        `Google Workspace tool ${event.toolName} requires per-call user confirmation.`,
    };
    if (!ctx.hasUI) {
      return blocked;
    }
    try {
      const approved = await queueMcpConfirmation(ctx.ui, () =>
        ctx.ui.confirm(
          'Google Workspace write operation',
          `Allow ${event.toolName}?\n\n${JSON.stringify(event.input, null, 2)}`,
        ));
      return approved ? undefined : blocked;
    } catch {
      return blocked;
    }
  });
}
