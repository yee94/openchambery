/**
 * Chat overflow menu model — Cap MobileApp overflow hooks for phone chat.
 * Cap order (phone): new-session first, then Files / Changes / MCP / refresh.
 * Capgo `update` is 故意不移植. iPad-only Settings omitted (Lynx has Settings tab).
 */
import type { LynxGitStatusResult } from './changesSurface';

export type LynxChatOverflowItemId =
  | 'newSession'
  | 'files'
  | 'changes'
  | 'mcp'
  | 'refreshTranscript';

export type LynxChatOverflowItem = {
  id: LynxChatOverflowItemId;
  labelKey:
    | 'lynx.chat.menu.newSession'
    | 'lynx.chat.menu.files'
    | 'lynx.chat.menu.changes'
    | 'lynx.chat.menu.mcp'
    | 'lynx.chat.menu.refresh';
  /** When true, selecting navigates to a labeled stub sheet (not real data). */
  stubSheet?: boolean;
};

export const LYNX_CHAT_OVERFLOW_ITEMS: readonly LynxChatOverflowItem[] = [
  { id: 'newSession', labelKey: 'lynx.chat.menu.newSession' },
  { id: 'files', labelKey: 'lynx.chat.menu.files' },
  { id: 'changes', labelKey: 'lynx.chat.menu.changes' },
  { id: 'mcp', labelKey: 'lynx.chat.menu.mcp' },
  { id: 'refreshTranscript', labelKey: 'lynx.chat.menu.refresh' },
] as const;

export type LynxChatSheetKind = 'files' | 'changes' | 'mcp';

export function chatSheetFromOverflowId(
  id: LynxChatOverflowItemId,
): LynxChatSheetKind | null {
  if (id === 'files' || id === 'changes' || id === 'mcp') return id;
  return null;
}

/**
 * Cap MobileApp `dirtyChangeCount = gitStatus?.files?.length ?? 0` on Changes overflow.
 * no-runtime / failure / no-directory → null (no fake badge).
 * ok → entry count (0 allowed; UI may hide zero).
 */
export function dirtyChangeBadgeFromGitStatus(
  result: LynxGitStatusResult | null | undefined,
): number | null {
  if (!result || result.status !== 'ok') return null;
  return result.entries.length;
}

export type LynxChatOverflowItemWithBadge = LynxChatOverflowItem & {
  /** Cap Changes dirty badge; omit/null when unknown or failed. */
  badge?: number | null;
};

/** Attach Changes badge when git status is available; never invent from failure. */
export function withOverflowDirtyBadge(
  items: readonly LynxChatOverflowItem[],
  dirtyCount: number | null | undefined,
): LynxChatOverflowItemWithBadge[] {
  return items.map((item) => {
    if (item.id !== 'changes') return { ...item };
    if (dirtyCount == null) return { ...item, badge: null };
    return { ...item, badge: dirtyCount };
  });
}
