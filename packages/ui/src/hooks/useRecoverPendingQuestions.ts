import React from "react"

import {
  collectUnansweredQuestionToolIds,
  shouldRecoverPendingQuestions,
  type RecoverableMessageRecord,
} from "@/sync/recover-pending-questions"
import { resyncBlockingRequestsForDirectory, useChildStoreManager } from "@/sync/sync-context"

/**
 * Viewed-session safety net for a missed `question.asked`.
 * Only lists when the current transcript has an unanswered question tool
 * and the scoped store is empty. One attempt per session + unanswered ids.
 */
export function useRecoverPendingQuestions(
  sessionId: string | null,
  directory: string | undefined,
  messages: RecoverableMessageRecord[],
  sessionQuestionCount: number,
): void {
  const childStores = useChildStoreManager()
  const attemptedKeyRef = React.useRef<string | null>(null)
  const scopeRef = React.useRef(`${sessionId ?? ""}:${directory ?? ""}`)

  React.useEffect(() => {
    const scope = `${sessionId ?? ""}:${directory ?? ""}`
    if (scopeRef.current !== scope) {
      attemptedKeyRef.current = null
      scopeRef.current = scope
    }

    const decision = shouldRecoverPendingQuestions({
      sessionId,
      directory,
      sessionQuestionCount,
      unansweredToolIds: collectUnansweredQuestionToolIds(messages),
      attemptedKey: attemptedKeyRef.current,
    })
    if (!decision.recover || !sessionId || !directory || !decision.attemptKey) return

    const store = childStores.getChild(directory)
    if (!store) return

    // Consume the attempt before the list so an empty/failed list cannot loop.
    attemptedKeyRef.current = decision.attemptKey
    void resyncBlockingRequestsForDirectory(directory, store, [sessionId])
  }, [sessionId, directory, messages, sessionQuestionCount, childStores])
}
