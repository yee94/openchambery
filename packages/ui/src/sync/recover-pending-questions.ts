export type RecoverableMessageRecord = {
  parts?: unknown[]
}

// Mirrors ToolPart's question-output parser without importing the renderer.
// "User has answered your questions: "Q1"="A1". You can now..."
export function parseQuestionOutput(output: string): Array<{ question: string; answer: string }> | null {
  const match = output.match(/^User has answered your questions:\s*(.+?)\.\s*You can now/s)
  if (!match) return null

  const pairs: Array<{ question: string; answer: string }> = []
  const content = match[1]
  const pairRegex = /"([^"]+)"="([^"]*(?:[^"\\]|\\.)*)"/g
  let pairMatch
  while ((pairMatch = pairRegex.exec(content)) !== null) {
    pairs.push({
      question: pairMatch[1],
      answer: pairMatch[2],
    })
  }
  return pairs.length > 0 ? pairs : null
}

function readQuestionToolId(part: Record<string, unknown>): string | null {
  if (typeof part.id === "string" && part.id) return part.id
  if (typeof part.callID === "string" && part.callID) return part.callID
  const state = part.state
  if (state && typeof state === "object" && !Array.isArray(state)) {
    const callID = (state as { callID?: unknown }).callID
    if (typeof callID === "string" && callID) return callID
  }
  return null
}

function isUnansweredQuestionToolPart(part: unknown): boolean {
  if (!part || typeof part !== "object" || Array.isArray(part)) return false
  const record = part as Record<string, unknown>
  if (record.type !== "tool" || record.tool !== "question") return false

  const state = record.state && typeof record.state === "object" && !Array.isArray(record.state)
    ? record.state as Record<string, unknown>
    : {}
  const status = typeof state.status === "string" ? state.status : undefined
  if (status === "error") return false
  if (status === "pending" || status === "running" || status === undefined) return true
  if (status !== "completed") return false

  const output = typeof state.output === "string" ? state.output : ""
  if (!output) return true
  return parseQuestionOutput(output) == null
}

export function collectUnansweredQuestionToolIds(messages: RecoverableMessageRecord[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    const parts = Array.isArray(message.parts) ? message.parts : []
    for (const part of parts) {
      if (!isUnansweredQuestionToolPart(part)) continue
      const id = readQuestionToolId(part as Record<string, unknown>)
      if (id) ids.push(id)
    }
  }
  return ids
}

function buildPendingQuestionRecoverKey(sessionId: string, unansweredToolIds: string[]): string {
  return `${sessionId}:${unansweredToolIds.join(",")}`
}

export function shouldRecoverPendingQuestions(input: {
  sessionId: string | null | undefined
  directory: string | null | undefined
  sessionQuestionCount: number
  unansweredToolIds: string[]
  attemptedKey: string | null
}): { recover: boolean; attemptKey: string | null } {
  const sessionId = input.sessionId?.trim() ?? ""
  const directory = input.directory?.trim() ?? ""
  if (!sessionId || !directory) {
    return { recover: false, attemptKey: null }
  }
  if (input.sessionQuestionCount > 0 || input.unansweredToolIds.length === 0) {
    return { recover: false, attemptKey: null }
  }
  const attemptKey = buildPendingQuestionRecoverKey(sessionId, input.unansweredToolIds)
  if (input.attemptedKey === attemptKey) {
    return { recover: false, attemptKey }
  }
  return { recover: true, attemptKey }
}

/**
 * Viewed-session safety net: if the transcript still has an unanswered
 * question tool but the scoped question store is empty, list once.
 * Does not invent QuestionRequest from tool parts — only `question.list`.
 * The attempt key is consumed before `resync` so an empty list cannot loop.
 */
export async function recoverPendingQuestionsIfNeeded<TStore>(input: {
  sessionId: string | null | undefined
  directory: string | null | undefined
  sessionQuestionCount: number
  messages: RecoverableMessageRecord[]
  attemptedKey: string | null
  getStore: (directory: string) => TStore | undefined
  resync: (directory: string, store: TStore, candidateSessionIds?: string[]) => Promise<void>
}): Promise<{ attemptedKey: string | null; recovered: boolean }> {
  const unansweredToolIds = collectUnansweredQuestionToolIds(input.messages)
  const decision = shouldRecoverPendingQuestions({
    sessionId: input.sessionId,
    directory: input.directory,
    sessionQuestionCount: input.sessionQuestionCount,
    unansweredToolIds,
    attemptedKey: input.attemptedKey,
  })
  const sessionId = input.sessionId?.trim() ?? ""
  const directory = input.directory?.trim() ?? ""
  if (!decision.recover || !sessionId || !directory || !decision.attemptKey) {
    return { attemptedKey: decision.attemptKey ?? input.attemptedKey, recovered: false }
  }
  const store = input.getStore(directory)
  if (!store) {
    return { attemptedKey: input.attemptedKey, recovered: false }
  }
  try {
    await input.resync(directory, store, [sessionId])
  } catch {
    // resyncBlockingRequestsForDirectory already preserves store on list
    // failure; this catch keeps a viewed-session recover from exploding.
  }
  return { attemptedKey: decision.attemptKey, recovered: true }
}
