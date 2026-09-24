/** Native projection recovery after a long gap: retain paint and recover history through native cursors. */
import { expect, test } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { createQueryTranscriptRepository } from "./transcript-repository-query-adapter"
import { createTranscriptReconnectCompensationController } from "./session-transcript-reconnect-compensation"

test("long-gap reconnect retains loaded history and exposes the new tail cursor for the missing middle", async () => {
  const client = new QueryClient()
  const scope = { directory: "/repo", sessionID: "ses_gap", transport: "relay-gap", generation: 1 }
  const record = (n) => ({ info: { id: `msg_${n}`, sessionID: scope.sessionID, role: "user", time: { created: n } },
    parts: [{ id: `p_${n}`, messageID: `msg_${n}`, sessionID: scope.sessionID, type: "text", text: `message ${n}` }] })
  const history = Array.from({ length: 100 }, (_, i) => record(i + 1))
  const calls = []
  let release
  const probe = { getTransport: () => scope.transport, getGeneration: () => 1 }
  const repo = createQueryTranscriptRepository({ client, probe, fetcher: async ({ before }) => {
    calls.push(before ?? "tail")
    if (!before) await new Promise((resolve) => { release = resolve })
    const end = before ? Number(before) : history.length
    const start = Math.max(0, end - 20)
    return { records: history.slice(start, end), cursor: start ? String(start) : undefined, complete: start === 0, turnCount: end - start }
  } })
  const recovery = createTranscriptReconnectCompensationController({ client, repository: repo, probe,
    listDirectories: () => [scope.directory], getViewedSession: () => scope, getBusyOrRetrySessionIDs: () => [] })
  try {
    repo.apply(scope, { type: "http-page", purpose: "initial", page: { records: history.slice(0, 20), complete: true, turnCount: 20 } })
    recovery.captureCheckpoints({ lastEventID: "old", reason: "offline" })
    recovery.onCompensation({ isReconnect: true, runtimeGeneration: 1 })
    expect(repo.getTranscript(scope).messageOrder).toHaveLength(20)
    const flight = recovery.ensureOnObserve(scope)
    release()
    await flight
    expect(calls).toEqual(["tail"])
    expect(repo.getTranscript(scope).messageOrder).toHaveLength(40)
    expect(repo.getPagination(scope).cursor).toBe("80")
    for (let i = 0; i < 4; i += 1) await repo.fetchPreviousPage(scope)
    expect(calls).toEqual(["tail", "80", "60", "40", "20"])
    expect(new Set(repo.getTranscript(scope).messageOrder).size).toBe(100)
    expect(repo.getTranscript(scope).messageOrder).toEqual(history.map((entry) => entry.info.id))
    expect(repo.getPagination(scope).isComplete).toBe(true)
  } finally { recovery.destroy(); repo.destroy(); client.clear() }
})
