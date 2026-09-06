/**
 * Chat overflow menu model — Cap MobileApp overflow hooks for Files / Changes
 * entry points (and extensible session actions). Bodies may still be stubs.
 */

export type LynxChatOverflowItemId =
  | 'files'
  | 'changes'
  | 'refreshTranscript';

export type LynxChatOverflowItem = {
  id: LynxChatOverflowItemId;
  labelKey:
    | 'lynx.chat.menu.files'
    | 'lynx.chat.menu.changes'
    | 'lynx.chat.menu.refresh';
  /** When true, selecting navigates to a labeled stub sheet (not fake-success data). */
  stubSheet?: boolean;
};

export const LYNX_CHAT_OVERFLOW_ITEMS: readonly LynxChatOverflowItem[] = [
  { id: 'files', labelKey: 'lynx.chat.menu.files', stubSheet: true },
  { id: 'changes', labelKey: 'lynx.chat.menu.changes', stubSheet: true },
  { id: 'refreshTranscript', labelKey: 'lynx.chat.menu.refresh' },
] as const;

export type LynxChatSheetKind = 'files' | 'changes';

export function chatSheetFromOverflowId(
  id: LynxChatOverflowItemId,
): LynxChatSheetKind | null {
  if (id === 'files' || id === 'changes') return id;
  return null;
}
