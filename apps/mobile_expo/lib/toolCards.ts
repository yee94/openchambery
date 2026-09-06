/**
 * Minimal Cap-parity tool card models for Expo Chat.
 * Ported from Cap toolRenderUtils + ProgressiveGroup short-description helpers.
 * Includes process Used fold + skill group aggregation (no LatticeOrb / FlipUp).
 */

import type { ChatMessagePart } from '@/lib/sessionMessages';
import {
  collectConsecutiveProcessTools,
  formatProcessSummary,
  hasProcessSuccessor,
  isProcessGroupActive,
  isProcessGroupTool,
} from '@/lib/processToolGrouping';
import {
  collectConsecutiveSkillTools,
  formatSkillSummary,
  getSkillNameFromToolPart,
  isSkillGroupTool,
} from '@/lib/skillToolGrouping';

export type ToolCardStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'error'
  | 'aborted'
  | 'unknown';

export type ToolCardModel = {
  id: string;
  toolName: string;
  displayName: string;
  status: ToolCardStatus;
  settled: boolean;
  description: string | null;
  output: string | null;
  error: string | null;
};

export type ReasoningModel = {
  id: string;
  text: string;
  summary: string;
  /** True while stream is open (no end time / active status). */
  streaming: boolean;
};

export type UsedFoldModel = {
  id: string;
  running: boolean;
  summary: string;
  cards: ToolCardModel[];
};

export type SkillGroupModel = {
  id: string;
  running: boolean;
  summary: string;
  cards: ToolCardModel[];
};

export type MessageSegment =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'tool'; id: string; card: ToolCardModel }
  | { kind: 'reasoning'; id: string; reasoning: ReasoningModel }
  | { kind: 'used-fold'; id: string; fold: UsedFoldModel }
  | { kind: 'skill-group'; id: string; group: SkillGroupModel };

const SETTLED = new Set(['completed', 'error', 'failed', 'aborted', 'timeout', 'cancelled']);
const ACTIVE = new Set(['pending', 'started', 'running']);

const DISPLAY_NAMES: Record<string, string> = {
  read: 'Read File',
  write: 'Write File',
  edit: 'Edit File',
  multiedit: 'Edit Files',
  apply_patch: 'Apply Patch',
  bash: 'Run',
  shell: 'Run',
  grep: 'Search Files',
  search: 'Search Files',
  glob: 'Find Files',
  list: 'List Files',
  webfetch: 'Fetch URL',
  websearch: 'Web Search',
  skill: 'Load Skill',
  task: 'Task',
  question: 'Question',
  todowrite: 'Update Todos',
  todoread: 'Read Todos',
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const normalizeToolName = (toolName: unknown): string => {
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

export const toolDisplayName = (toolName: string): string => {
  const id = normalizeToolName(toolName);
  if (id && DISPLAY_NAMES[id]) return DISPLAY_NAMES[id];
  if (!toolName.trim()) return 'Tool';
  // mcp_foo_bar → Mcp foo bar
  const raw = toolName.replace(/:\d+$/, '').trim();
  const spaced = raw.replace(/[_.-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

export const isToolPartSettled = (part: unknown): boolean => {
  const row = asRecord(part);
  if (!row) return false;
  const state = asRecord(row.state);
  if (!state) return false;

  const status = typeof state.status === 'string' ? state.status.trim().toLowerCase() : '';
  if (ACTIVE.has(status)) return false;
  if (SETTLED.has(status)) return true;

  const time = asRecord(state.time);
  if (!time) return false;
  const end = time.end;
  const start = time.start;
  if (typeof end !== 'number' || !Number.isFinite(end)) return false;
  return typeof start !== 'number' || !Number.isFinite(start) || end >= start;
};

const statusOf = (part: Record<string, unknown>): ToolCardStatus => {
  const state = asRecord(part.state);
  const status = typeof state?.status === 'string' ? state.status.trim().toLowerCase() : '';
  if (status === 'pending') return 'pending';
  if (status === 'started' || status === 'running') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'error' || status === 'failed') return 'error';
  if (status === 'aborted' || status === 'cancelled' || status === 'timeout') return 'aborted';
  if (isToolPartSettled(part)) return 'completed';
  return 'unknown';
};

const fileNameFromInput = (input: Record<string, unknown> | null, metadata: Record<string, unknown> | null): string | null => {
  const filePath =
    (typeof input?.filePath === 'string' && input.filePath) ||
    (typeof input?.file_path === 'string' && input.file_path) ||
    (typeof input?.path === 'string' && input.path) ||
    (typeof metadata?.filePath === 'string' && metadata.filePath) ||
    (typeof metadata?.file_path === 'string' && metadata.file_path) ||
    (typeof metadata?.path === 'string' && metadata.path) ||
    '';
  if (!filePath.trim()) return null;
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
};

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}…` : value;

/** Cap ProgressiveGroup short-description subset for common tools. */
export const toolShortDescription = (part: ChatMessagePart): string | null => {
  const row = part as Record<string, unknown>;
  const toolName = normalizeToolName(typeof row.tool === 'string' ? row.tool : '');
  const state = asRecord(row.state);
  const input = asRecord(state?.input);
  const metadata = asRecord(state?.metadata);

  if (toolName === 'grep' || toolName === 'search' || toolName === 'find' || toolName === 'ripgrep') {
    const pattern = input?.pattern;
    if (typeof pattern === 'string' && pattern.trim()) return truncate(pattern.trim(), 40);
  }
  if (toolName === 'glob') {
    const pattern = input?.pattern;
    if (typeof pattern === 'string' && pattern.trim()) return truncate(pattern.trim(), 40);
  }
  if (
    toolName === 'websearch' ||
    toolName === 'web-search' ||
    toolName === 'search_web' ||
    toolName === 'codesearch' ||
    toolName === 'perplexity'
  ) {
    const query = input?.query;
    if (typeof query === 'string' && query.trim()) return truncate(query.trim(), 50);
  }
  if (toolName === 'skill') {
    const name =
      (typeof metadata?.name === 'string' && metadata.name) ||
      (typeof input?.name === 'string' && input.name) ||
      (typeof input?.id === 'string' && input.id) ||
      '';
    if (name.trim()) return name.trim();
  }
  if (toolName === 'webfetch' || toolName === 'fetch' || toolName === 'curl' || toolName === 'wget') {
    const url =
      (typeof input?.url === 'string' && input.url) ||
      (typeof input?.URL === 'string' && input.URL) ||
      (typeof metadata?.url === 'string' && metadata.url) ||
      '';
    if (url.trim()) return url.trim();
  }
  if (toolName === 'bash' || toolName === 'shell' || toolName === 'cmd' || toolName === 'terminal') {
    const command =
      (typeof input?.command === 'string' && input.command) ||
      (typeof input?.cmd === 'string' && input.cmd) ||
      '';
    if (command.trim()) return truncate(command.trim().replace(/\s+/g, ' '), 60);
  }
  if (toolName === 'todowrite' || toolName === 'todoread') {
    return 'todos';
  }
  return fileNameFromInput(input, metadata);
};

export const toolCardFromPart = (part: ChatMessagePart, index: number): ToolCardModel | null => {
  if (part.type !== 'tool') return null;
  const row = part as Record<string, unknown>;
  const toolRaw = typeof row.tool === 'string' ? row.tool : 'tool';
  const state = asRecord(row.state);
  const output =
    typeof state?.output === 'string'
      ? state.output
      : typeof row.output === 'string'
        ? row.output
        : null;
  const error =
    typeof state?.error === 'string'
      ? state.error
      : typeof row.error === 'string'
        ? row.error
        : null;
  const id =
    (typeof part.id === 'string' && part.id) ||
    (typeof row.callID === 'string' && row.callID) ||
    `tool_${index}_${normalizeToolName(toolRaw) || 'x'}`;

  return {
    id,
    toolName: toolRaw,
    displayName: toolDisplayName(toolRaw),
    status: statusOf(row),
    settled: isToolPartSettled(part),
    description: toolShortDescription(part),
    output,
    error,
  };
};

const SUMMARY_MAX = 80;

export const cleanReasoningText = (text: string): string => {
  if (!text || !text.trim()) return '';
  return text
    .split('\n')
    .map((line) => line.replace(/^>\s?/, '').trimEnd())
    .filter((line) => line.trim().length > 0)
    .join('\n')
    .trim();
};

export const reasoningSummary = (text: string): string => {
  const cleaned = cleanReasoningText(text)
    .replace(/```[\w]*\n?([\s\S]*?)```/g, (_, inner: string) => inner.trim())
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= SUMMARY_MAX) return cleaned;
  const cut = cleaned.lastIndexOf(' ', SUMMARY_MAX);
  const end = cut > 0 ? cut : SUMMARY_MAX;
  return `${cleaned.slice(0, end).trimEnd()}…`;
};

export const reasoningFromPart = (part: ChatMessagePart, index: number): ReasoningModel | null => {
  if (part.type !== 'reasoning') return null;
  const text = typeof part.text === 'string' ? part.text : '';
  const time = asRecord((part as Record<string, unknown>).time);
  const hasEnded = typeof time?.end === 'number';
  const id = (typeof part.id === 'string' && part.id) || `reasoning_${index}`;
  return {
    id,
    text: cleanReasoningText(text),
    summary: reasoningSummary(text),
    streaming: !hasEnded && text.length > 0,
  };
};

const toolNameOf = (part: ChatMessagePart): unknown =>
  (part as Record<string, unknown>).tool;

/** Ordered segments for one message — Cap MessageBody / ProgressiveGroup subset. */
export const segmentsFromParts = (
  parts: ChatMessagePart[] | undefined,
  options?: { isTurnLive?: boolean },
): MessageSegment[] => {
  if (!parts?.length) return [];
  const isTurnLive = Boolean(options?.isTurnLive);
  const segments: MessageSegment[] = [];
  let index = 0;
  while (index < parts.length) {
    const part = parts[index]!;

    if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
      const id = (typeof part.id === 'string' && part.id) || `text_${index}`;
      segments.push({ kind: 'text', id, text: part.text });
      index += 1;
      continue;
    }

    if (part.type === 'reasoning') {
      const reasoning = reasoningFromPart(part, index);
      if (reasoning && (reasoning.text || reasoning.streaming)) {
        segments.push({ kind: 'reasoning', id: reasoning.id, reasoning });
      }
      index += 1;
      continue;
    }

    if (part.type === 'tool') {
      const toolName = toolNameOf(part);

      if (isProcessGroupTool(toolName)) {
        const grouped = collectConsecutiveProcessTools(parts, index, toolNameOf);
        const cards = grouped.items
          .map((item, offset) => toolCardFromPart(item, index + offset))
          .filter((card): card is ToolCardModel => card != null);
        if (cards.length > 0) {
          const hasFollowingOtherType = hasProcessSuccessor(parts, grouped.end, (item) => ({
            type: item.type,
            toolName: toolNameOf(item),
          }));
          const running = isProcessGroupActive({
            parts: grouped.items,
            hasFollowingOtherType,
            isTurnLive,
          });
          const id = `used_${cards[0]!.id}`;
          segments.push({
            kind: 'used-fold',
            id,
            fold: {
              id,
              running,
              summary: formatProcessSummary(grouped.items.map(toolNameOf)),
              cards,
            },
          });
        }
        index = grouped.end;
        continue;
      }

      if (isSkillGroupTool(toolName)) {
        const grouped = collectConsecutiveSkillTools(parts, index, toolNameOf);
        const cards = grouped.items
          .map((item, offset) => toolCardFromPart(item, index + offset))
          .filter((card): card is ToolCardModel => card != null);
        if (cards.length > 0) {
          const running = grouped.items.some((item) => !isToolPartSettled(item));
          const names = grouped.items.map(getSkillNameFromToolPart);
          const id = `skill_${cards[0]!.id}`;
          segments.push({
            kind: 'skill-group',
            id,
            group: {
              id,
              running,
              summary: formatSkillSummary(
                names,
                (joined, count) => `${joined} and ${count} more`,
              ),
              cards,
            },
          });
        }
        index = grouped.end;
        continue;
      }

      const card = toolCardFromPart(part, index);
      if (card) segments.push({ kind: 'tool', id: card.id, card });
      index += 1;
      continue;
    }

    index += 1;
  }
  return segments;
};

/** Merge a live part into an existing parts array by id (or append). */
export const mergeLivePart = (
  parts: ChatMessagePart[],
  incoming: ChatMessagePart,
): ChatMessagePart[] => {
  const id = typeof incoming.id === 'string' ? incoming.id : null;
  if (!id) return [...parts, incoming];
  const index = parts.findIndex((p) => p.id === id);
  if (index < 0) return [...parts, incoming];
  const next = parts.slice();
  next[index] = { ...parts[index], ...incoming };
  return next;
};

export const partsSignature = (parts: ChatMessagePart[] | undefined): string => {
  if (!parts?.length) return '';
  return parts
    .map((p) => {
      if (p.type === 'text') return `t:${p.id ?? ''}:${(p.text ?? '').length}`;
      if (p.type === 'reasoning') {
        const time = asRecord((p as Record<string, unknown>).time);
        return `r:${p.id ?? ''}:${(p.text ?? '').length}:${time?.end ?? ''}`;
      }
      if (p.type === 'tool') {
        const state = asRecord((p as Record<string, unknown>).state);
        return `k:${p.id ?? ''}:${String((p as Record<string, unknown>).tool ?? '')}:${String(state?.status ?? '')}:${typeof state?.output === 'string' ? state.output.length : 0}`;
      }
      return `o:${p.type ?? ''}:${p.id ?? ''}`;
    })
    .join('|');
};
