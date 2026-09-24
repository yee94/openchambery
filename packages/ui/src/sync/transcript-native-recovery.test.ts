import { afterEach, expect, test } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { createQueryTranscriptRepository } from "./transcript-repository-query-adapter"
import { createTranscriptReconnectCompensationController } from "./session-transcript-reconnect-compensation"
import type { Message, Part } from "@/lib/opencode/v2-types"
import type { TranscriptTransportPage } from "./transcript-repository"

const scope = { directory: "/repo", sessionID: "ses_a", transport: "relay-test", generation: 1 }
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

test("reconnect recovers through the native repository without clearing a warm transcript", async () => {
  const client = new QueryClient()
  let complete!: (page: TranscriptTransportPage) => void
  let pulls = 0
  const probe = { getTransport: () => scope.transport, getGeneration: () => scope.generation }
  const repo = createQueryTranscriptRepository({ client, probe, fetcher: () => {
    pulls += 1
    return new Promise((resolve) => { complete = resolve })
  } })
  const record = { info: { id: "msg_a", sessionID: scope.sessionID, role: "user", time: { created: 1 } } as Message,
    parts: [{ id: "part_a", messageID: "msg_a", sessionID: scope.sessionID, type: "text", text: "cached" } as Part] }
  repo.apply(scope, { type: "http-page", purpose: "initial", page: { records: [record], complete: true } })
  const recovery = createTranscriptReconnectCompensationController({ client, repository: repo, probe,
    listDirectories: () => [scope.directory], getBusyOrRetrySessionIDs: () => [], getViewedSession: () => scope })
  cleanups.push(() => { recovery.destroy(); repo.destroy(); client.clear() })
  recovery.captureCheckpoints({ lastEventID: "event_a", reason: "disconnect" })
  recovery.onCompensation({ isReconnect: true, runtimeGeneration: 1 } as Parameters<typeof recovery.onCompensation>[0])
  await Promise.resolve()
  expect(pulls).toBe(1)
  expect(repo.getTranscript(scope).messageOrder).toEqual(["msg_a"])
  complete({ records: [record], complete: true })
  await recovery.ensureOnObserve(scope)
  expect(repo.getTranscript(scope).messageOrder).toEqual(["msg_a"])
})
