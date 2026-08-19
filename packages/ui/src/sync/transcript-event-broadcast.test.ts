import { describe, expect, test } from "bun:test"

import { listTranscriptEventBroadcastScopes } from "./transcript-event-broadcast"
import type { TranscriptScope } from "./transcript-repository"

const TRANSPORT = "test-transport"
const GENERATION = 1
const SESSION = "ses_1"

function scope(
  directory: string,
  extras: Partial<TranscriptScope> = {},
): TranscriptScope {
  return {
    directory,
    sessionID: SESSION,
    transport: TRANSPORT,
    generation: GENERATION,
    ...extras,
  }
}

describe("listTranscriptEventBroadcastScopes", () => {
  test("returns every matching canonical scope when two directories hit", () => {
    const listed = [
      scope("/repo-a"),
      scope("/repo-b"),
    ]
    const result = listTranscriptEventBroadcastScopes({
      sessionID: SESSION,
      resolvedDirectory: "/repo-a",
      transport: TRANSPORT,
      generation: GENERATION,
      listCanonicalScopes: () => listed,
    })
    expect(result).toEqual(listed)
  })

  test("returns the single matching canonical scope", () => {
    const listed = [scope("/repo-a")]
    const result = listTranscriptEventBroadcastScopes({
      sessionID: SESSION,
      resolvedDirectory: "/repo-a",
      transport: TRANSPORT,
      generation: GENERATION,
      listCanonicalScopes: () => listed,
    })
    expect(result).toEqual(listed)
  })

  test("falls back to resolvedDirectory when no canonical scope hits", () => {
    const result = listTranscriptEventBroadcastScopes({
      sessionID: SESSION,
      resolvedDirectory: "/resolved",
      transport: TRANSPORT,
      generation: GENERATION,
      listCanonicalScopes: () => [],
    })
    expect(result).toEqual([
      {
        directory: "/resolved",
        sessionID: SESSION,
        transport: TRANSPORT,
        generation: GENERATION,
      },
    ])
  })
})
