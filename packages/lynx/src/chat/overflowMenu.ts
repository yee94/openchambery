/**
 * Chat overflow menu model — Cap MobileApp overflow hooks for phone chat.
 * Cap order (phone): new-session first, then Files / Changes / MCP / refresh.
 * Capgo `update` is 故意不移植. iPad-only Settings omitted (Lynx has Settings tab).
 */
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
