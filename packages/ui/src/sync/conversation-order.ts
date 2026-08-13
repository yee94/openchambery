/**
 * Conversation position helpers.
 *
 * Transcript `messageOrder` is oldest → newest. Message id strings are identity
 * only — they are not a before/after key. Revert visibility, the revert dock,
 * user-message history, and slash undo/redo all read through these helpers.
 */

type ConversationMessage = {
  id: string
  role?: string
}

export function conversationIndexOf(
  conversation: readonly ConversationMessage[],
  messageId: string,
): number {
  return conversation.findIndex((message) => message.id === messageId)
}

/**
 * Messages strictly before the revert target. If the target is missing, return
 * the full conversation (fail visible — never hide by id lexicographic order).
 */
export function messagesVisibleWithRevert<T extends ConversationMessage>(
  conversation: readonly T[],
  revertMessageID: string | undefined,
): T[] {
  if (!revertMessageID) return conversation.slice()
  const revertIndex = conversationIndexOf(conversation, revertMessageID)
  if (revertIndex < 0) return conversation.slice()
  return conversation.slice(0, revertIndex)
}

/** True when `messageId` is the revert target or after it in conversation order. */
export function isAtOrAfterRevert(
  conversation: readonly ConversationMessage[],
  messageId: string,
  revertMessageID: string,
): boolean {
  const revertIndex = conversationIndexOf(conversation, revertMessageID)
  if (revertIndex < 0) return false
  const index = conversationIndexOf(conversation, messageId)
  return index >= revertIndex
}

/**
 * Previous user turn before the current revert target.
 * With no revert marker, the latest user turn.
 * Missing target → undefined (do not guess from id order).
 */
export function resolveRevertUndoTarget<T extends ConversationMessage>(
  conversation: readonly T[],
  revertMessageID: string | undefined,
): T | undefined {
  if (!revertMessageID) {
    for (let index = conversation.length - 1; index >= 0; index -= 1) {
      const message = conversation[index]
      if (message?.role === "user") return message
    }
    return undefined
  }
  const revertIndex = conversationIndexOf(conversation, revertMessageID)
  if (revertIndex < 0) return undefined
  for (let index = revertIndex - 1; index >= 0; index -= 1) {
    const message = conversation[index]
    if (message?.role === "user") return message
  }
  return undefined
}

/**
 * Next user turn after the current revert target.
 * Missing target → undefined (do not guess from id order).
 */
export function resolveRevertRedoTarget<T extends ConversationMessage>(
  conversation: readonly T[],
  revertMessageID: string,
): T | undefined {
  const revertIndex = conversationIndexOf(conversation, revertMessageID)
  if (revertIndex < 0) return undefined
  for (let index = revertIndex + 1; index < conversation.length; index += 1) {
    const message = conversation[index]
    if (message?.role === "user") return message
  }
  return undefined
}
