/**
 * Shared MCP client core for Pi extensions that expose a hosted MCP server
 * through a single `list_tools` / `describe_tool` / `call_tool` tool.
 */

import {StringEnum} from '@earendil-works/pi-ai';
import {
  type AgentToolResult,
  defineTool,
} from '@earendil-works/pi-coding-agent';
import {type Static, type TSchema, Type} from 'typebox';
import {Check, Errors} from 'typebox/value';

// ── Validation helper ──────────────────────────────────────────────────────

export function describeValidationFailure(
  schema: TSchema,
  value: unknown,
): string {
  const errs = Errors(schema, value).slice(0, 3).map((e) =>
    `${e.instancePath || '(root)'}: ${e.message}`
  );
  return errs.join('; ') || 'value did not match expected schema';
}

// ── MCP schemas ─────────────────────────────────────────────────────────────

const McpToolInputSchemaSchema = Type.Object({
  type: Type.Optional(Type.String()),
  properties: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  required: Type.Optional(Type.Array(Type.String())),
});

const McpToolAnnotationsSchema = Type.Object({
  title: Type.Optional(Type.String()),
  readOnlyHint: Type.Optional(Type.Boolean()),
  destructiveHint: Type.Optional(Type.Boolean()),
  idempotentHint: Type.Optional(Type.Boolean()),
  openWorldHint: Type.Optional(Type.Boolean()),
});

export const McpToolSchema = Type.Object({
  name: Type.String({minLength: 1}),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  inputSchema: Type.Optional(McpToolInputSchemaSchema),
  annotations: Type.Optional(McpToolAnnotationsSchema),
});
export type McpTool = Static<typeof McpToolSchema>;

const McpToolsListResultSchema = Type.Object({
  tools: Type.Array(Type.Unknown()),
});

// Loose JSON-RPC 2.0 response envelope. We only assert that the envelope is an
// object and, if `error` is present, that it is an object too. The inner
// `error.message` is left as `unknown` so a non-string message (out-of-spec,
// but observed in the wild) doesn't turn an upstream error into a 'malformed
// response' error.
const McpRpcResponseSchema = Type.Object({
  jsonrpc: Type.Optional(Type.String()),
  id: Type.Optional(Type.Unknown()),
  result: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.Object({
    code: Type.Optional(Type.Unknown()),
    message: Type.Optional(Type.Unknown()),
    data: Type.Optional(Type.Unknown()),
  })),
});

export function validateTools(input: unknown, maxTools: number): McpTool[] {
  if (!Check(McpToolsListResultSchema, input)) {
    throw new Error(
      `MCP tools/list returned an unexpected shape: ${
        describeValidationFailure(McpToolsListResultSchema, input)
      }`,
    );
  }
  const out: McpTool[] = [];
  // Validate per-entry rather than as a single Array(McpToolSchema): a single
  // malformed tool from upstream should not blank the whole catalog. Entries
  // that don't conform are dropped silently.
  for (const t of input.tools) {
    if (out.length >= maxTools) {
      break;
    }
    if (Check(McpToolSchema, t)) {
      out.push(t);
    }
  }
  return out;
}

// ── MCP client (JSON-RPC over Streamable HTTP) ──────────────────────────────

export interface McpClientOptions {
  /** Human-readable name used in error messages (e.g. "Slack", "Datadog"). */
  label: string;
  /** Returns the MCP endpoint URL (may include a query string). */
  url(): string;
  /** Returns a fresh, valid access token; refresh logic lives in the caller. */
  getAccessToken(): Promise<string>;
  /**
   * Invoked once on a 401/404 before the single retry, so the caller can drop
   * its cached token (the next `getAccessToken` should re-fetch/refresh).
   */
  invalidateAuth?(): void;
  /** Protocol version sent in `initialize`. */
  protocolVersion: string;
  /** Client identity sent in `initialize`. */
  clientInfo: {name: string; version: string};
  /** Whether to POST a `notifications/initialized` after `initialize`. */
  sendInitialized?: boolean;
  /** Cap on tools returned by `listTools`. Default 200. */
  maxTools?: number;
  /** Per-request timeout. Default 30s. */
  requestTimeoutMs?: number;
  /** How long a session id is reused before re-initializing. Default 22h. */
  sessionTtlMs?: number;
}

export interface McpClient {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Drop the cached session and tool catalog (e.g. on logout/shutdown). */
  reset(): void;
}

export function createMcpClient(opts: McpClientOptions): McpClient {
  const maxTools = opts.maxTools ?? 200;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  const sessionTtlMs = opts.sessionTtlMs ?? 22 * 60 * 60 * 1000;

  let sessionId: string | null = null;
  let sessionFor: string | null = null; // accessToken the session was opened for
  let sessionOpenedAt = 0;
  let cachedTools: McpTool[] | null = null;

  async function mcpFetch(
    accessToken: string,
    body: unknown,
    sid?: string,
  ): Promise<{resp: Response; sessionIdOut: string | null; json: unknown}> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${accessToken}`,
    };
    if (sid) {
      headers['mcp-session-id'] = sid;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), requestTimeoutMs);
    let resp: Response;
    try {
      resp = await fetch(opts.url(), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }

    const sessionIdOut = resp.headers.get('mcp-session-id');
    const contentType = (resp.headers.get('content-type') ?? '').toLowerCase();
    let json: unknown = null;
    if (resp.ok) {
      const text = await resp.text();
      if (contentType.includes('text/event-stream')) {
        // Concatenate the `data:` lines of the (single) SSE message into one
        // JSON payload.
        const dataLines = text
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim());
        const joined = dataLines.join('');
        json = joined ? JSON.parse(joined) : null;
      } else if (text) {
        json = JSON.parse(text);
      }
    }
    return {resp, sessionIdOut, json};
  }

  async function ensureSession(): Promise<
    {accessToken: string; sessionId: string}
  > {
    const accessToken = await opts.getAccessToken();
    const fresh = sessionFor === accessToken && sessionId &&
      Date.now() - sessionOpenedAt < sessionTtlMs;
    if (fresh && sessionId) {
      return {accessToken, sessionId};
    }
    const {resp, sessionIdOut} = await mcpFetch(accessToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: opts.protocolVersion,
        capabilities: {},
        clientInfo: opts.clientInfo,
      },
    });
    if (!resp.ok) {
      throw new Error(
        `${opts.label} MCP initialize failed: HTTP ${resp.status}`,
      );
    }
    if (!sessionIdOut) {
      throw new Error(
        `${opts.label} MCP initialize did not return a session id`,
      );
    }
    sessionId = sessionIdOut;
    sessionFor = accessToken;
    sessionOpenedAt = Date.now();
    if (opts.sendInitialized) {
      // A notification carries no id and expects no result; ignore failures.
      await mcpFetch(
        accessToken,
        {jsonrpc: '2.0', method: 'notifications/initialized', params: {}},
        sessionIdOut,
      ).catch(() => undefined);
    }
    return {accessToken, sessionId: sessionIdOut};
  }

  function extractResult<T>(json: unknown, method: string): T {
    if (json === null || json === undefined) {
      throw new Error(`${opts.label} MCP ${method}: empty response`);
    }
    if (!Check(McpRpcResponseSchema, json)) {
      throw new Error(
        `${opts.label} MCP ${method}: malformed JSON-RPC response: ${
          describeValidationFailure(McpRpcResponseSchema, json)
        }`,
      );
    }
    if (json.error) {
      const msg = typeof json.error.message === 'string'
        ? json.error.message
        : 'unknown error';
      throw new Error(`${opts.label} MCP ${method} error: ${msg}`);
    }
    return json.result as T;
  }

  async function rpc<T>(method: string, params: unknown = {}): Promise<T> {
    const session = await ensureSession();
    const {resp, json} = await mcpFetch(session.accessToken, {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1_000_000),
      method,
      params,
    }, session.sessionId);

    if (resp.status === 401 || resp.status === 404) {
      // Session/token invalidated: clear and retry exactly once.
      sessionId = null;
      sessionFor = null;
      opts.invalidateAuth?.();
      const retry = await ensureSession();
      const {resp: r2, json: j2} = await mcpFetch(retry.accessToken, {
        jsonrpc: '2.0',
        id: Math.floor(Math.random() * 1_000_000),
        method,
        params,
      }, retry.sessionId);
      if (!r2.ok) {
        throw new Error(
          `${opts.label} MCP ${method} failed after retry: HTTP ${r2.status}`,
        );
      }
      return extractResult<T>(j2, method);
    }
    if (!resp.ok) {
      throw new Error(
        `${opts.label} MCP ${method} failed: HTTP ${resp.status}`,
      );
    }
    return extractResult<T>(json, method);
  }

  return {
    async listTools() {
      if (cachedTools) {
        return cachedTools;
      }
      const result = await rpc<unknown>('tools/list');
      cachedTools = validateTools(result, maxTools);
      return cachedTools;
    },
    async callTool(name, args) {
      return rpc<unknown>('tools/call', {name, arguments: args});
    },
    reset() {
      sessionId = null;
      sessionFor = null;
      cachedTools = null;
    },
  };
}

// ── Tool-catalog helpers ─────────────────────────────────────────────────────

export function summarizeDescription(desc: string | undefined): string {
  if (!desc) {
    return '';
  }
  const flat = desc.replace(/\s+/g, ' ').trim();
  const firstSentence = flat.match(/^.*?\.(?=\s|$)/);
  return (firstSentence ? firstSentence[0] : flat).slice(0, 240);
}

// Builds an `isWriteTool` predicate. The server's `readOnlyHint` annotation,
// when present, takes precedence; otherwise the tool name is split on common
// separators and considered mutating if any token is in `verbs`. This is
// intentionally over-inclusive: a false positive only adds a confirmation
// prompt; a false negative could let the agent mutate without a gate.
export function makeIsWriteTool(
  verbs: Set<string>,
): (tool: McpTool) => boolean {
  return (tool: McpTool): boolean => {
    const hint = tool.annotations?.readOnlyHint;
    if (hint === true) {
      return false;
    }
    if (hint === false) {
      return true;
    }
    for (const tok of tool.name.toLowerCase().split(/[._\-]+/)) {
      if (verbs.has(tok)) {
        return true;
      }
    }
    return false;
  };
}

function jsonTypeOf(v: unknown): string {
  if (v === null) {
    return 'null';
  }
  if (Array.isArray(v)) {
    return 'array';
  }
  return typeof v;
}

function matchesJsonType(v: unknown, t: string): boolean {
  switch (t) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number';
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'array':
      return Array.isArray(v);
    case 'object':
      return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'null':
      return v === null;
    default:
      return true; // unknown type keyword: pass through
  }
}

// Minimal local validator for the common JSON Schema subset that MCP tool
// inputSchemas actually use: `required`, `type` (string or union), and `enum`.
// Returns null on success or a short human-readable message on the first
// failure. Anything more exotic (oneOf, $ref, pattern, etc.) is intentionally
// ignored so the upstream server still sees the call.
export function validateArgsAgainstSchema(
  args: unknown,
  schema: McpTool['inputSchema'],
): string | null {
  if (!schema) {
    return null;
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return 'tool_args must be a JSON object';
  }
  const obj = args as Record<string, unknown>;
  for (const name of schema.required ?? []) {
    if (!(name in obj)) {
      return `missing required field '${name}'`;
    }
  }
  const props = schema.properties ?? {};
  for (const [key, value] of Object.entries(obj)) {
    const propSchema = props[key] as
      | {type?: string | string[]; enum?: unknown[]}
      | undefined;
    if (!propSchema) {
      continue;
    }
    const expected = propSchema.type;
    if (expected) {
      const types = Array.isArray(expected) ? expected : [expected];
      if (!types.some((t) => matchesJsonType(value, t))) {
        return `field '${key}' has wrong type: expected ${
          types.join('|')
        }, got ${jsonTypeOf(value)}`;
      }
    }
    if (Array.isArray(propSchema.enum) && !propSchema.enum.includes(value)) {
      return `field '${key}' has invalid value: expected one of ${
        JSON.stringify(propSchema.enum)
      }`;
    }
  }
  return null;
}

export function unknownToolError(
  name: string,
  tools: McpTool[],
  label: string,
): string {
  const lower = name.toLowerCase();
  const tokens = lower.split(/[._\-]+/).filter(Boolean);
  const ranked = tools
    .map((t) => {
      const n = t.name.toLowerCase();
      let score = 0;
      if (n.includes(lower)) {
        score += 5;
      }
      for (const tok of tokens) {
        if (tok && n.includes(tok)) {
          score += 1;
        }
      }
      return {name: t.name, score};
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.name);
  const catalog = tools.map((t) => t.name).join(', ');
  const suggestionLine = ranked.length
    ? `Closest matches: ${ranked.join(', ')}.\n`
    : '';
  return (
    `Error: unknown ${label} tool '${name}'. Do not guess tool names.\n` +
    suggestionLine +
    `Available tools: ${catalog}\n` +
    `Use action="describe_tool" with tool_name to get the input schema before calling.`
  );
}

// ── Proxy-tool factory ────────────────────────────────────────────────────────

export type McpProxyResult = AgentToolResult<Record<string, unknown>>;

export interface ProxyToolOptions {
  /** Tool name the LLM calls (e.g. "slack", "datadog"). */
  name: string;
  /** Human-readable label for the UI and error messages. */
  label: string;
  /** Full tool description shown to the LLM. */
  description: string;
  client: McpClient;
  isWriteTool(tool: McpTool): boolean;
  /** Whether mutating calls may proceed without a confirmation prompt. */
  writesAllowed(): boolean;
  /** Confirmation-dialog copy for mutating tools. */
  writeGate: {title: string; envHint: string};
  /**
   * Optional hook to convert a thrown error into a tool result (e.g. turn a
   * "not authenticated" sentinel into a user-facing instruction). Return
   * undefined to rethrow.
   */
  handleError?(err: unknown): McpProxyResult | undefined;
}

export function defineMcpProxyTool(opts: ProxyToolOptions) {
  return defineTool({
    name: opts.name,
    label: opts.label,
    description: opts.description,
    parameters: Type.Object({
      action: StringEnum(
        ['list_tools', 'describe_tool', 'call_tool'] as const,
        {description: 'Action to perform'},
      ),
      tool_name: Type.Optional(
        Type.String({
          description:
            `${opts.label} MCP tool name (required for describe_tool and call_tool)`,
        }),
      ),
      tool_args: Type.Optional(
        Type.Unknown({
          description:
            'Arguments for the tool call as a JSON object (required for call_tool)',
        }),
      ),
    }),

    async execute(
      _id,
      params,
      _signal,
      _onUpdate,
      ctx,
    ): Promise<McpProxyResult> {
      try {
        if (params.action === 'list_tools') {
          const tools = await opts.client.listTools();
          const catalog = tools.map((t) => ({
            name: t.name,
            summary: summarizeDescription(t.description),
            mutating: opts.isWriteTool(t),
          }));
          return {
            content: [{type: 'text', text: JSON.stringify(catalog, null, 2)}],
            details: {action: 'list_tools', count: tools.length},
          };
        }

        if (params.action === 'describe_tool') {
          if (!params.tool_name) {
            throw new Error('tool_name is required for describe_tool');
          }
          const tools = await opts.client.listTools();
          const tool = tools.find((t) => t.name === params.tool_name);
          if (!tool) {
            throw new Error(
              unknownToolError(params.tool_name, tools, opts.label),
            );
          }
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(
                {
                  name: tool.name,
                  title: tool.title,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                  mutating: opts.isWriteTool(tool),
                },
                null,
                2,
              ),
            }],
            details: {action: 'describe_tool', tool: tool.name},
          };
        }

        if (params.action === 'call_tool') {
          if (!params.tool_name) {
            throw new Error('tool_name is required for call_tool');
          }
          const toolName = params.tool_name;
          const args = typeof params.tool_args === 'string'
            ? JSON.parse(params.tool_args)
            : ((params.tool_args as Record<string, unknown> | undefined) ?? {});

          // Validate the tool name locally against the catalog so a guessed
          // name turns into a self-healing prompt instead of a cryptic
          // upstream error.
          const tools = await opts.client.listTools();
          const tool = tools.find((t) => t.name === toolName);
          if (!tool) {
            throw new Error(unknownToolError(toolName, tools, opts.label));
          }

          const validationError = validateArgsAgainstSchema(
            args,
            tool.inputSchema,
          );
          if (validationError) {
            throw new Error(
              `Invalid arguments for ${toolName}: ${validationError}. ` +
                `Use action="describe_tool" with tool_name="${toolName}" to see the full schema.`,
            );
          }

          if (opts.isWriteTool(tool) && !opts.writesAllowed()) {
            const argPreview = JSON.stringify(args, null, 2).slice(0, 1500);
            const ok = await ctx.ui.confirm(
              opts.writeGate.title,
              `pi wants to call mutating ${opts.label} tool:\n  ${toolName}\n\nArgs:\n${argPreview}\n\n(${opts.writeGate.envHint})`,
            );
            if (!ok) {
              throw new Error(`Blocked by user: ${toolName}`);
            }
          }

          const result = await opts.client.callTool(toolName, args);
          const text = typeof result === 'string'
            ? result
            : JSON.stringify(result, null, 2);
          return {
            content: [{type: 'text', text}],
            details: {
              action: 'call_tool',
              tool: toolName,
              mutating: opts.isWriteTool(tool),
            },
          };
        }

        throw new Error(`Unknown action: ${params.action as string}`);
      } catch (e) {
        const handled = opts.handleError?.(e);
        if (handled) {
          return handled;
        }
        throw e;
      }
    },
  });
}
