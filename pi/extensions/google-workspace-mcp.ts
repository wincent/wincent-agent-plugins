/** Per-call write confirmation for the native MCP server named `google_workspace`. */
import {type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {registerMcpPermissionGate} from './lib/mcp.js';

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
  registerMcpPermissionGate(pi, {
    server: 'google_workspace',
    label: 'Google Workspace',
    isWriteTool: (tool) =>
      !READ_ONLY_TOOL_NAMES.has(tool.name.slice(TOOL_PREFIX.length)) ||
      tool.annotations?.readOnlyHint === false ||
      tool.annotations?.destructiveHint === true,
  });
}
