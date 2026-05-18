/**
 * Discovery and parsing of agent .md files.
 *
 * Frontmatter is intentionally minimal (see PLAN.md "Agent definitions"):
 *
 *   description       (required)
 *   tools             (required)
 *   disallowed_tools  (optional)
 *   placement         (optional)
 *   worktree          (optional)
 *   close_on_success  (optional)
 *
 * Frontmatter is authoritative for the fields it sets. Per-call `subagent`
 * tool parameters fill in fields the agent file leaves unspecified.
 */

import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export type Placement =
  | 'split-right'
  | 'split-down'
  | 'window'
  | 'window-detached';

export type AgentSource = 'project' | 'user' | 'extension';

export interface AgentConfig {
  name: string;
  description: string;
  tools: string[];
  disallowedTools?: string[];
  placement: Placement;
  worktree: boolean;
  closeOnSuccess: boolean;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

interface RawFrontmatter {
  description?: string;
  tools?: string;
  disallowed_tools?: string;
  placement?: string;
  worktree?: string | boolean;
  close_on_success?: string | boolean;
}

interface ParsedFrontmatter {
  frontmatter: RawFrontmatter;
  body: string;
}

/**
 * Minimal frontmatter parser. Accepts simple `key: value` lines between
 * leading `---` fences. Values are strings (with `true`/`false` later
 * coerced by parseBool). Skips comment lines (`#`). Sufficient for our
 * agent .md frontmatter; not a full YAML parser.
 */
function parseFrontmatter(content: string): ParsedFrontmatter {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return {frontmatter: {}, body: content};
  }
  const fm: Record<string, string> = {};
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') {
      end = i;
      break;
    }
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) {
      continue;
    }
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key.length > 0) {
      fm[key] = value;
    }
  }
  if (end < 0) {
    return {frontmatter: {}, body: content};
  }
  return {
    frontmatter: fm as RawFrontmatter,
    body: lines.slice(end + 1).join('\n'),
  };
}

const VALID_PLACEMENTS: ReadonlySet<Placement> = new Set([
  'split-right',
  'split-down',
  'window',
  'window-detached',
]);

function parseBool(
  value: string | boolean | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === 'yes' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === 'no' || normalized === '0') {
    return false;
  }
  return fallback;
}

function parsePlacement(
  value: string | undefined,
  fallback: Placement,
): Placement {
  if (!value) {
    return fallback;
  }
  const trimmed = value.trim() as Placement;
  return VALID_PLACEMENTS.has(trimmed) ? trimmed : fallback;
}

function parseToolList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function loadAgentsFromDir(
  dir: string,
  source: AgentSource,
): AgentConfig[] {
  if (!existsSync(dir)) {
    return [];
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) {
      continue;
    }
    const filePath = join(dir, entry);
    let s;
    try {
      s = statSync(filePath);
    } catch {
      continue;
    }
    if (!s.isFile()) {
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(raw);
    const frontmatter = parsed.frontmatter;
    const body = parsed.body;
    const tools = parseToolList(frontmatter.tools);
    if (!frontmatter.description || tools.length === 0) {
      // Skip silently: an .md without description+tools isn't an agent.
      continue;
    }
    const name = entry.replace(/\.md$/, '');
    agents.push({
      name,
      description: frontmatter.description,
      tools,
      disallowedTools: frontmatter.disallowed_tools
        ? parseToolList(frontmatter.disallowed_tools)
        : undefined,
      placement: parsePlacement(frontmatter.placement, 'split-right'),
      worktree: parseBool(
        frontmatter.worktree as string | boolean | undefined,
        false,
      ),
      closeOnSuccess: parseBool(
        frontmatter.close_on_success as string | boolean | undefined,
        true,
      ),
      systemPrompt: body.trim(),
      source,
      filePath,
    });
  }
  return agents;
}

function findProjectAgentsDir(cwd: string): string | null {
  let current = cwd;
  while (true) {
    const candidate = join(current, '.pi', 'agents');
    try {
      if (statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // ignored
    }
    const parent = join(current, '..');
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function userAgentsDir(): string {
  const piDir = process.env.PI_CODING_AGENT_DIR
    ?? join(homedir(), '.pi', 'agent');
  return join(piDir, 'agents');
}

/**
 * The extension's own bundled agents/ directory, found relative to this
 * module's location. Works in both production (pi loads agents.ts via
 * jiti) and tests (jiti-register hook), since import.meta.url is stable.
 */
function extensionAgentsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'agents');
}

export interface DiscoveryResult {
  agents: AgentConfig[];
  extensionDir: string;
  userDir: string;
  projectDir: string | null;
}

/**
 * Discover agents from three locations, in order of increasing precedence:
 *
 *   1. Extension-bundled (pi/extensions/subagent/agents/*.md, located
 *      relative to this module's URL)
 *   2. User              (~/.pi/agent/agents/*.md, or $PI_CODING_AGENT_DIR)
 *   3. Project           (<cwd>/.pi/agents/*.md, walking upward to repo root)
 *
 * Later sources override earlier ones for the same agent name, so a user
 * can shadow a shipped agent and a project can shadow a user agent.
 */
export function discoverAgents(cwd: string): DiscoveryResult {
  const extensionDir = extensionAgentsDir();
  const userDir = userAgentsDir();
  const projectDir = findProjectAgentsDir(cwd);

  const extensionAgents = loadAgentsFromDir(extensionDir, 'extension');
  const userAgents = loadAgentsFromDir(userDir, 'user');
  const projectAgents = projectDir
    ? loadAgentsFromDir(projectDir, 'project')
    : [];

  const byName = new Map<string, AgentConfig>();
  for (const agent of extensionAgents) {
    byName.set(agent.name, agent);
  }
  for (const agent of userAgents) {
    byName.set(agent.name, agent);
  }
  for (const agent of projectAgents) {
    byName.set(agent.name, agent);
  }
  return {
    agents: Array.from(byName.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    ),
    extensionDir,
    userDir,
    projectDir,
  };
}
