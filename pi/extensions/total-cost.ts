/**
 * Total Cost Extension
 *
 * Adds a `/total-cost` command that scans every saved pi session under
 * `$PI_CODING_AGENT_DIR/sessions` (default `~/.pi/agent/sessions`) and shows a
 * per-month breakdown of cumulative LLM cost, message count, and number of
 * distinct sessions that contributed. By default the cost is also broken down
 * per model, with one extra column per model.
 *
 * Optional arguments:
 *   - `no-model-breakdown` suppresses the per-model columns and shows totals
 *     only.
 *   - any other word is treated as a model-name filter: only models whose name
 *     contains one of the given substrings are counted, and the cost, message,
 *     and session columns reflect just those models (for example `claude`
 *     restricts the table to Claude models). Filters and `no-model-breakdown`
 *     can be combined.
 *
 * Costs come from the `usage.cost.total` field stored on each assistant
 * message and the model from `message.model`. Months are bucketed by the
 * entry-level ISO timestamp (UTC).
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import {DynamicBorder} from '@earendil-works/pi-coding-agent';
import {Container, Text, matchesKey} from '@earendil-works/pi-tui';
import {readFile, readdir, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

const UNKNOWN_MODEL = 'unknown';

const NO_MODEL_BREAKDOWN_FLAG = 'no-model-breakdown';

interface ModelStats {
  cost: number;
  messages: number;
  sessions: Set<string>;
}

interface RawData {
  months: Map<string, Map<string, ModelStats>>; // month -> model -> stats
  files: number;
  skippedFiles: number;
}

type ModelFilter = (model: string) => boolean;

interface MonthBucket {
  month: string; // YYYY-MM
  cost: number;
  messages: number;
  sessions: Set<string>;
  modelCost: Map<string, number>;
}

interface Totals {
  cost: number;
  messages: number;
  sessions: number;
  files: number;
  skippedFiles: number;
  byMonth: MonthBucket[];
  models: string[]; // model names ordered by total cost, descending
  modelTotals: Map<string, number>;
}

function getSessionsDir(): string {
  const base = process.env.PI_CODING_AGENT_DIR?.trim() ||
    join(homedir(), '.pi', 'agent');
  return join(base, 'sessions');
}

async function listSessionFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  let projectDirs: string[];
  try {
    projectDirs = await readdir(dir);
  } catch {
    return result;
  }

  for (const project of projectDirs) {
    const projectPath = join(dir, project);
    let files: string[];
    try {
      const st = await stat(projectPath);
      if (!st.isDirectory()) {
        continue;
      }
      files = await readdir(projectPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.endsWith('.jsonl')) {
        result.push(join(projectPath, file));
      }
    }
  }
  return result;
}

function bucketKey(timestamp: string | number | undefined): string | null {
  if (timestamp === undefined || timestamp === null) {
    return null;
  }
  const d = typeof timestamp === 'number'
    ? new Date(timestamp)
    : new Date(timestamp);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

async function collectData(): Promise<RawData> {
  const sessionsDir = getSessionsDir();
  const files = await listSessionFiles(sessionsDir);

  const months = new Map<string, Map<string, ModelStats>>();
  let skippedFiles = 0;

  for (const file of files) {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      skippedFiles++;
      continue;
    }

    const lines = raw.split('\n');
    for (const line of lines) {
      if (!line) {
        continue;
      }
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // tolerate corrupt/partial trailing lines
      }

      if (entry?.type !== 'message') {
        continue;
      }
      const message = entry.message;
      if (!message || message.role !== 'assistant') {
        continue;
      }

      const cost = message.usage?.cost?.total;
      if (
        typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0
      ) {
        continue;
      }

      // Prefer entry-level ISO timestamp; fall back to message timestamp (unix ms).
      const month = bucketKey(entry.timestamp) ?? bucketKey(message.timestamp);
      if (!month) {
        continue;
      }

      const model = typeof message.model === 'string' && message.model.trim()
        ? message.model
        : UNKNOWN_MODEL;

      let byModel = months.get(month);
      if (!byModel) {
        byModel = new Map();
        months.set(month, byModel);
      }
      let stats = byModel.get(model);
      if (!stats) {
        stats = {cost: 0, messages: 0, sessions: new Set()};
        byModel.set(model, stats);
      }
      stats.cost += cost;
      stats.messages += 1;
      stats.sessions.add(file);
    }
  }

  return {months, files: files.length, skippedFiles};
}

function summarize(raw: RawData, filter: ModelFilter | null): Totals {
  const byMonth: MonthBucket[] = [];
  let totalCost = 0;
  let totalMessages = 0;
  const allSessions = new Set<string>();
  const modelTotals = new Map<string, number>();

  for (const [month, byModel] of raw.months) {
    let cost = 0;
    let messages = 0;
    const sessions = new Set<string>();
    const modelCost = new Map<string, number>();

    for (const [model, stats] of byModel) {
      if (filter && !filter(model)) {
        continue;
      }
      cost += stats.cost;
      messages += stats.messages;
      for (const file of stats.sessions) {
        sessions.add(file);
      }
      modelCost.set(model, stats.cost);
      modelTotals.set(model, (modelTotals.get(model) ?? 0) + stats.cost);
    }

    if (messages === 0) {
      continue; // no models matched the filter this month
    }

    byMonth.push({month, cost, messages, sessions, modelCost});
    totalCost += cost;
    totalMessages += messages;
    for (const file of sessions) {
      allSessions.add(file);
    }
  }

  byMonth.sort((a, b) => (a.month < b.month ? 1 : -1));

  const models = [...modelTotals.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([name]) => name);

  return {
    cost: totalCost,
    messages: totalMessages,
    sessions: allSessions.size,
    files: raw.files,
    skippedFiles: raw.skippedFiles,
    byMonth,
    models,
    modelTotals,
  };
}

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

type Align = 'left' | 'right';

interface ColumnSpec {
  header: string;
  align: Align;
  dataColor: string;
  totalColor: string;
}

interface TableModel {
  columns: ColumnSpec[];
  rows: string[][]; // one entry per month, parallel to columns
  totalRow: string[];
}

const COL_GAP = '  ';

function pad(s: string, width: number, align: Align): string {
  const fill = ' '.repeat(Math.max(0, width - s.length));
  return align === 'left' ? s + fill : fill + s;
}

function buildTableModel(totals: Totals, showModels: boolean): TableModel {
  const models = showModels ? totals.models : [];

  const columns: ColumnSpec[] = [
    {header: 'Month', align: 'left', dataColor: 'accent', totalColor: 'accent'},
    {
      header: 'Cost',
      align: 'right',
      dataColor: 'warning',
      totalColor: 'warning',
    },
    ...models.map((model): ColumnSpec => ({
      header: model,
      align: 'right',
      dataColor: 'success',
      totalColor: 'success',
    })),
    {header: 'Messages', align: 'right', dataColor: 'dim', totalColor: 'muted'},
    {header: 'Sessions', align: 'right', dataColor: 'dim', totalColor: 'muted'},
  ];

  const modelCells = (lookup: Map<string, number>): string[] =>
    models.map((model) => {
      const cost = lookup.get(model) ?? 0;
      return cost > 0 ? fmtMoney(cost) : '-';
    });

  const rows = totals.byMonth.map((
    b,
  ) => [
    b.month,
    fmtMoney(b.cost),
    ...modelCells(b.modelCost),
    fmtInt(b.messages),
    fmtInt(b.sessions.size),
  ]);

  const totalRow = [
    'Total',
    fmtMoney(totals.cost),
    ...modelCells(totals.modelTotals),
    fmtInt(totals.messages),
    fmtInt(totals.sessions),
  ];

  return {columns, rows, totalRow};
}

function columnWidths(model: TableModel): number[] {
  return model.columns.map((col, i) => {
    let width = col.header.length;
    for (const row of model.rows) {
      width = Math.max(width, row[i].length);
    }
    return Math.max(width, model.totalRow[i].length);
  });
}

function tableWidth(widths: number[]): number {
  return widths.reduce((a, b) => a + b, 0) +
    COL_GAP.length * Math.max(0, widths.length - 1);
}

function renderThemedTable(model: TableModel, theme: any): string[] {
  const widths = columnWidths(model);
  const rule = theme.fg('dim', '─'.repeat(tableWidth(widths)));
  const lines: string[] = [];

  lines.push(
    model.columns
      .map((col, i) => theme.fg('muted', pad(col.header, widths[i], col.align)))
      .join(COL_GAP),
  );
  lines.push(rule);

  for (const row of model.rows) {
    lines.push(
      model.columns
        .map((col, i) =>
          theme.fg(col.dataColor, pad(row[i], widths[i], col.align))
        )
        .join(COL_GAP),
    );
  }

  lines.push(rule);
  lines.push(
    model.columns
      .map((col, i) =>
        theme.bold(
          theme.fg(
            col.totalColor,
            pad(model.totalRow[i], widths[i], col.align),
          ),
        )
      )
      .join(COL_GAP),
  );

  return lines;
}

function renderPlainTable(model: TableModel): string[] {
  const widths = columnWidths(model);
  const rule = '─'.repeat(tableWidth(widths));
  const renderRow = (cells: string[]) =>
    cells
      .map((cell, i) => pad(cell, widths[i], model.columns[i].align))
      .join(COL_GAP);

  return [
    renderRow(model.columns.map((c) => c.header)),
    rule,
    ...model.rows.map(renderRow),
    rule,
    renderRow(model.totalRow),
  ];
}

function filterNote(filterTokens: string[]): string {
  return `Filtered to models matching: ${filterTokens.join(', ')}`;
}

function emptyMessage(filterTokens: string[]): string {
  return filterTokens.length > 0
    ? `No models matching ${filterTokens.join(', ')} found.`
    : 'No sessions with cost data found.';
}

function buildLines(
  totals: Totals,
  theme: any,
  showModels: boolean,
  filterTokens: string[],
): string[] {
  const lines: string[] = [];

  if (totals.byMonth.length === 0) {
    lines.push(theme.fg('muted', emptyMessage(filterTokens)));
    lines.push(
      theme.fg(
        'dim',
        `Scanned ${
          fmtInt(totals.files)
        } session file(s) in ${getSessionsDir()}`,
      ),
    );
    return lines;
  }

  if (filterTokens.length > 0) {
    lines.push(theme.fg('muted', filterNote(filterTokens)));
    lines.push('');
  }
  lines.push(...renderThemedTable(buildTableModel(totals, showModels), theme));
  lines.push('');
  if (showModels && totals.models.length > 0) {
    lines.push(
      theme.fg(
        'dim',
        'Tip: pass `no-model-breakdown` to hide the per-model columns.',
      ),
    );
  }
  lines.push(
    theme.fg(
      'dim',
      `Scanned ${fmtInt(totals.files)} session file(s) in ${getSessionsDir()}`,
    ) +
      (totals.skippedFiles > 0
        ? theme.fg('warning', `, skipped ${totals.skippedFiles}`)
        : ''),
  );

  return lines;
}

async function showTotals(
  totals: Totals,
  ctx: ExtensionCommandContext,
  showModels: boolean,
  filterTokens: string[],
): Promise<void> {
  if (!ctx.hasUI) {
    // Fallback for non-interactive modes: print plain text.
    const plain: string[] = ['Total Cost by Month'];
    if (totals.byMonth.length === 0) {
      plain.push(emptyMessage(filterTokens));
    } else {
      if (filterTokens.length > 0) {
        plain.push(filterNote(filterTokens));
      }
      plain.push(...renderPlainTable(buildTableModel(totals, showModels)));
    }
    plain.push('');
    plain.push(
      `Scanned ${fmtInt(totals.files)} session file(s) in ${getSessionsDir()}` +
        (totals.skippedFiles > 0 ? `, skipped ${totals.skippedFiles}` : ''),
    );
    console.log(plain.join('\n'));
    return;
  }

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const container = new Container();
    const border = new DynamicBorder((s: string) => theme.fg('accent', s));
    container.addChild(border);
    container.addChild(
      new Text(theme.fg('accent', theme.bold('Total Cost by Month')), 1, 1),
    );
    for (const line of buildLines(totals, theme, showModels, filterTokens)) {
      container.addChild(new Text(line, 1, 0));
    }
    container.addChild(
      new Text(theme.fg('dim', 'Press Enter or Esc to close'), 1, 1),
    );
    container.addChild(border);

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, 'enter') || matchesKey(data, 'escape')) {
          done(undefined);
        }
      },
    };
  });
}

interface ParsedArgs {
  showModels: boolean;
  filterTokens: string[];
}

function parseArgs(args: string): ParsedArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const isFlag = (token: string) =>
    token.toLowerCase() === NO_MODEL_BREAKDOWN_FLAG;
  return {
    showModels: !tokens.some(isFlag),
    filterTokens: tokens.filter((token) => !isFlag(token)),
  };
}

function makeModelFilter(filterTokens: string[]): ModelFilter | null {
  if (filterTokens.length === 0) {
    return null;
  }
  const needles = filterTokens.map((token) => token.toLowerCase());
  return (model) => {
    const name = model.toLowerCase();
    return needles.some((needle) => name.includes(needle));
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand('total-cost', {
    description:
      'Show total LLM cost across all sessions, broken down by month and ' +
      'model. Pass a model-name substring (e.g. "claude") to filter to ' +
      'matching models, or `no-model-breakdown` for totals only',
    getArgumentCompletions: (prefix: string) => {
      const item = {
        value: NO_MODEL_BREAKDOWN_FLAG,
        label: NO_MODEL_BREAKDOWN_FLAG,
        description: 'Hide the per-model columns and show totals only',
      };
      return item.value.startsWith(prefix.trim()) ? [item] : [];
    },
    handler: async (args, ctx) => {
      const {showModels, filterTokens} = parseArgs(args);
      if (ctx.hasUI) {
        ctx.ui.notify('Computing total cost across sessions…', 'info');
      }
      let totals: Totals;
      try {
        const raw = await collectData();
        totals = summarize(raw, makeModelFilter(filterTokens));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) {
          ctx.ui.notify(`Failed to compute totals: ${msg}`, 'error');
        } else {
          console.error(`Failed to compute totals: ${msg}`);
        }
        return;
      }
      await showTotals(totals, ctx, showModels, filterTokens);
    },
  });
}
