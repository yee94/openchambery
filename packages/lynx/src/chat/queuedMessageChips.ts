/**
 * Cap QueuedMessageChips helpers for Lynx — local composerActions queue.
 *
 * Cap also has server `/api/openchamber/message-queue` + DnD-kit reorder.
 * Lynx uses the existing local queue (composerActions) and portable up/down
 * reorder (no @dnd-kit). Server message-queue is deferred until a Lynx
 * runtime path exists — do not invent TanStack mutation flights here.
 */
import type { LynxQueuedPrompt } from './composerActions';

export type LynxQueueChipItem = {
  id: string;
  text: string;
  createdAt: number;
  /** Optional presentation while send-now is in flight. */
  sending?: boolean;
};

export const lynxQueuedMessagePreviewLine = (text: string): string => {
  const firstLine = (text.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim();
  if (!firstLine) return '';
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
};

export const toLynxQueueChipItems = (
  queue: readonly LynxQueuedPrompt[],
  sendingIds: ReadonlySet<string> = new Set(),
): LynxQueueChipItem[] =>
  queue.map((item) => ({
    id: item.id,
    text: item.text,
    createdAt: item.createdAt,
    sending: sendingIds.has(item.id),
  }));

export const canRemoveLynxQueueChip = (item: LynxQueueChipItem): boolean => !item.sending;

export const canSendNowLynxQueueChip = (
  item: LynxQueueChipItem,
  options: { sessionIsWorking?: boolean; hasDispatchLock?: boolean } = {},
): boolean => {
  if (item.sending) return false;
  if (options.hasDispatchLock) return false;
  if (options.sessionIsWorking) return false;
  return item.text.trim().length > 0;
};

/**
 * Portable reorder (Cap uses @dnd-kit). Move `activeId` to the index of `overId`.
 * Returns a new array; no-op when ids missing or identical.
 */
export const reorderLynxQueueChips = <T extends { id: string }>(
  items: readonly T[],
  activeId: string,
  overId: string,
): T[] => {
  if (activeId === overId) return items.slice();
  const from = items.findIndex((item) => item.id === activeId);
  const to = items.findIndex((item) => item.id === overId);
  if (from < 0 || to < 0) return items.slice();
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  if (!moved) return items.slice();
  next.splice(to, 0, moved);
  return next;
};

export const moveLynxQueueChip = <T extends { id: string }>(
  items: readonly T[],
  id: string,
  direction: 'up' | 'down',
): T[] => {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return items.slice();
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= items.length) return items.slice();
  return reorderLynxQueueChips(items, id, items[target]!.id);
};

/** Whether the Cap-style queue shell should open (chips and/or trailing strip). */
export const shouldShowLynxQueueShell = (
  chipCount: number,
  hasTrailing: boolean,
): boolean => chipCount > 0 || hasTrailing;
