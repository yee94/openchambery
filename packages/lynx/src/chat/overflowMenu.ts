/**
 * Chat overflow menu model — Cap MobileApp overflow hooks for Files / Changes / MCP
 * entry points (and extensible session actions).
 */

export type LynxChatOverflowItemId =
  | 'files'
  | 'changes'
  | 'mcp'
  | 'refreshTranscript';

export type LynxChatOverflowItem = {
  id: LynxChatOverflowItemId;
  labelKey:
    | 'lynx.chat.menu.files'
    | 'lynx.chat.menu.changes'
    | 'lynx.chat.menu.mcp'
    | 'lynx.chat.menu.refresh';
  /** When true, selecting navigates to a labeled stub sheet (not real data). */
  stubSheet?: boolean;
};

export const LYNX_CHAT_OVERFLOW_ITEMS: readonly LynxChatOverflowItem[] = [
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
