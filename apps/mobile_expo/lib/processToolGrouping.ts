/**
 * Cap-parity process / Used fold grouping for Expo Chat.
 * Ported from packages/ui/.../processToolGrouping + usedToolGrouping + contextToolGrouping
 * + toolRenderUtils group predicates — summary labels only (no LatticeOrb / FlipUp).
 */

const normalizeToolName = (toolName: unknown): string => {
  if (typeof toolName !== 'string') return '';
  const trimmed = toolName.trim().toLowerCase();
  if (!trimmed) return '';
  const withoutIndex = trimmed.replace(/:\d+$/, '');
  if (withoutIndex.includes('.')) {
    const parts = withoutIndex.split('.').filter(Boolean);
    return parts[parts.length - 1] ?? withoutIndex;
  }
  return withoutIndex;
};

const SETTLED = new Set(['completed', 'error', 'failed', 'aborted', 'timeout', 'cancelled']);
const ACTIVE = new Set(['pending', 'started', 'running']);

const isToolPartSettled = (part: unknown): boolean => {
  if (!part || typeof part !== 'object') return false;
  const state = (part as { state?: unknown }).state;
  if (!state || typeof state !== 'object') return false;
  const status = (state as { status?: unknown }).status;
  if (typeof status === 'string') {
    const normalized = status.trim().toLowerCase();
    if (ACTIVE.has(normalized)) return false;
    if (SETTLED.has(normalized)) return true;
  }
  const time = (state as { time?: unknown }).time;
  if (!time || typeof time !== 'object') return false;
  const end = (time as { end?: unknown }).end;
  const start = (time as { start?: unknown }).start;
  if (typeof end !== 'number' || !Number.isFinite(end)) return false;
  return typeof start !== 'number' || !Number.isFinite(start) || end >= start;
};

const CONTEXT_GROUP_TOOL_NAMES = new Set(['read', 'glob', 'grep', 'list']);
const STANDALONE_TOOL_NAMES = new Set(['task']);
const EDIT_TOOL_NAMES = new Set([
  'edit',
  'multiedit',
  'write',
  'create',
  'file_write',
  'apply_patch',
  'patch',
]);
const COMMAND_TOOL_NAMES = new Set(['bash', 'shell', 'cmd', 'command', 'exec', 'terminal']);

export type ContextToolCountKey = 'read' | 'search' | 'list';
export type UsedToolCountKey = 'edit' | 'command' | 'other';
export type ProcessToolCountKey = ContextToolCountKey | UsedToolCountKey;

export type ProcessToolCounts = Record<ProcessToolCountKey, number>;

export const PROCESS_TOOL_COUNT_ORDER: readonly ProcessToolCountKey[] = [
  'search',
  'read',
  'list',
  'edit',
  'command',
  'other',
];

export const isContextGroupTool = (toolName: unknown): boolean =>
  CONTEXT_GROUP_TOOL_NAMES.has(normalizeToolName(toolName));

export const isSkillGroupTool = (toolName: unknown): boolean =>
  normalizeToolName(toolName) === 'skill';

export const isUsedGroupTool = (toolName: unknown): boolean => {
  const name = normalizeToolName(toolName);
  if (!name) return false;
  if (CONTEXT_GROUP_TOOL_NAMES.has(name)) return false;
  if (name === 'skill' || STANDALONE_TOOL_NAMES.has(name) || name === 'question') return false;
  return true;
};

/** Consecutive explore + used tools share one process / Used fold. */
export const isProcessGroupTool = (toolName: unknown): boolean =>
  isContextGroupTool(toolName) || isUsedGroupTool(toolName);

export const isStandaloneTool = (toolName: unknown): boolean =>
  STANDALONE_TOOL_NAMES.has(normalizeToolName(toolName));

export function contextToolCountKey(toolName: unknown): ContextToolCountKey | null {
  const name = normalizeToolName(toolName);
  if (name === 'read') return 'read';
  if (name === 'glob' || name === 'grep') return 'search';
  if (name === 'list') return 'list';
  return null;
}

export function usedToolCountKey(toolName: unknown): UsedToolCountKey | null {
  if (!isUsedGroupTool(toolName)) return null;
  const name = normalizeToolName(toolName);
  if (EDIT_TOOL_NAMES.has(name)) return 'edit';
  if (COMMAND_TOOL_NAMES.has(name)) return 'command';
  return 'other';
}

export function summarizeProcessTools(toolNames: readonly unknown[]): ProcessToolCounts {
  const counts: ProcessToolCounts = {
    read: 0,
    search: 0,
    list: 0,
    edit: 0,
    command: 0,
    other: 0,
  };
  for (const toolName of toolNames) {
    const contextKey = contextToolCountKey(toolName);
    if (contextKey) {
      counts[contextKey] += 1;
      continue;
    }
    const usedKey = usedToolCountKey(toolName);
    if (usedKey) counts[usedKey] += 1;
  }
  return counts;
}

/**
 * Reasoning stays inside a live process run.
 * Body text / skill / task / question settle it. Explore and used tools do not.
 */
export function isProcessSuccessorPart(input: {
  kind?: unknown;
  type?: unknown;
  toolName?: unknown;
}): boolean {
  if (input.kind === 'reasoning' || input.type === 'reasoning') return false;
  if (input.kind === 'justification' || input.type === 'text') return true;
  if (input.kind === 'tool' || input.type === 'tool') {
    return !isProcessGroupTool(input.toolName);
  }
  return input.kind != null || input.type != null;
}

export function hasProcessSuccessor<T>(
  items: readonly T[],
  start: number,
  read: (item: T) => { kind?: unknown; type?: unknown; toolName?: unknown },
): boolean {
  for (let index = start; index < items.length; index += 1) {
    if (isProcessSuccessorPart(read(items[index]))) return true;
  }
  return false;
}

export function isProcessGroupActive(
  partsOrInput:
    | readonly unknown[]
    | {
        parts: readonly unknown[];
        hasFollowingOtherType: boolean;
        isTurnLive: boolean;
      },
): boolean {
  if (!('parts' in partsOrInput)) {
    return partsOrInput.some((part) => !isToolPartSettled(part));
  }
  if (partsOrInput.parts.some((part) => !isToolPartSettled(part))) return true;
  if (partsOrInput.hasFollowingOtherType) return false;
  return partsOrInput.isTurnLive;
}

export function collectConsecutiveProcessTools<T>(
  items: readonly T[],
  start: number,
  getToolName: (item: T) => unknown,
): { items: T[]; end: number } {
  const grouped: T[] = [];
  let index = start;
  while (index < items.length && isProcessGroupTool(getToolName(items[index]))) {
    grouped.push(items[index]!);
    index += 1;
  }
  return { items: grouped, end: index };
}

/** English Cap-parity count labels (Expo i18n wraps via formatProcessSummary). */
export function formatProcessCountLabel(key: ProcessToolCountKey, count: number): string {
  if (key === 'search') return count === 1 ? '1 search' : `${count} searches`;
  if (key === 'read') return count === 1 ? '1 read' : `${count} reads`;
  if (key === 'list') return count === 1 ? '1 list' : `${count} lists`;
  if (key === 'edit') return count === 1 ? '1 edit' : `${count} edits`;
  if (key === 'command') return count === 1 ? '1 command' : `${count} commands`;
  return count === 1 ? '1 call' : `${count} calls`;
}

export function formatProcessSummary(toolNames: readonly unknown[]): string {
  const counts = summarizeProcessTools(toolNames);
  return PROCESS_TOOL_COUNT_ORDER.filter((key) => counts[key] > 0)
    .map((key) => formatProcessCountLabel(key, counts[key]))
    .join(', ');
}
