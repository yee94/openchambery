import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Event, Message, Part } from "@opencode-ai/sdk/v2/client"

import * as transcriptMerge from "./transcript-merge"
import { createQueryTranscriptRepository } from "./transcript-repository-query-adapter"
import type { TranscriptTransportPage } from "./transcript-repository"
const DIRECTORY = "/repo"
const SESSION = "ses_proj"
const TRANSPORT = "runtime-proj"
const GENERATION = 1

function userMessage(id: string, created = 1): Message {
  return { id, sessionID: SESSION, role: "user", time: { created } } as Message
}

function assistantMessage(id: string, created = 1): Message {
  return { id, sessionID: SESSION, role: "assistant", time: { created } } as Message
}

function textPart(id: string, messageID: string, text = id): Part {
  return { id, messageID, sessionID: SESSION, type: "text", text } as Part
}

function transportPage(
  records: Array<{ info: Message; parts?: Part[] }>,
  options: { cursor?: string; complete?: boolean; turnCount?: number } = {},
): TranscriptTransportPage {
  return {
    records: records.map((record) => ({
      info: record.info,
      parts: record.parts ?? [],
    })),
    cursor: options.cursor,
    complete: options.complete ?? !options.cursor,
    turnCount: options.turnCount ?? 1,
  }
}

describe("query transcript projection cache", () => {
  let client: QueryClient
  let projectSpy: ReturnType<typeof vi.spyOn>
  const scope = {
    directory: DIRECTORY,
    sessionID: SESSION,
    transport: TRANSPORT,
    generation: GENERATION,
  }

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 1 } },
    })
    projectSpy = vi.spyOn(transcriptMerge, "projectFlatFromTranscriptData")
  })

  afterEach(() => {
    projectSpy.mockRestore()
    client.clear()
  })

  test("multi-reader warm path projects once for the same immutable data", () => {
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
    })
    const older = Array.from({ length: 40 }, (_, i) => {
      const id = `msg_old_${i}`
      return { info: userMessage(id, i + 1), parts: [textPart(`p_${id}`, id, id)] }
    })
    const newer = Array.from({ length: 40 }, (_, i) => {
      const id = `msg_new_${i}`
      const info = i % 2 === 0 ? userMessage(id, 100 + i) : assistantMessage(id, 100 + i)
      return { info, parts: [textPart(`p_${id}`, id, id)] }
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage(newer, { cursor: "msg_new_0", complete: false, turnCount: 20 }),
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "prepend",
      page: transportPage(older, { complete: true, turnCount: 40 }),
    })

    // Same canonical identity: first reader pays once; peers share the result.
    // notify must not force another projectFlat for unchanged Query data.
    projectSpy.mockClear()
    const first = repo.getTranscript(scope)
    const second = repo.getTranscript(scope)
    const third = repo.getPagination(scope)
    const fourth = repo.getMessage(scope, "msg_new_0")
    const fifth = repo.getParts(scope, "msg_new_0")
    const sixth = repo.getTranscript(scope)

    expect(projectSpy).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
    expect(sixth).toBe(first)
    expect(first.messageOrder.length).toBe(80)
    expect(third.sessionID).toBe(SESSION)
    expect(fourth?.id).toBe("msg_new_0")
    expect(fifth[0]?.id).toBe("p_msg_new_0")
    repo.destroy()
  })

  test("write→repository multi-subscriber path reuses projection across notify", () => {
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
    })
    const seen: unknown[] = []
    const releaseA = repo.subscribe(scope, () => {
      seen.push(repo.getTranscript(scope))
    })
    const releaseB = repo.subscribe(scope, () => {
      seen.push(repo.getTranscript(scope))
    })

    projectSpy.mockClear()
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage(
        [
          { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "a")] },
          { info: assistantMessage("msg_2"), parts: [textPart("p2", "msg_2", "b")] },
        ],
        { complete: true },
      ),
    })
    // apply may notify via reducer path + Query cache subscription; each hop
    // fans out to both subscribers. All getTranscript calls must share one
    // projectFlat for the same canonical identity.
    const afterApplyProjects = projectSpy.mock.calls.length
    expect(afterApplyProjects).toBeGreaterThanOrEqual(1)
    expect(afterApplyProjects).toBeLessThanOrEqual(2)
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(new Set(seen).size).toBe(1)

    projectSpy.mockClear()
    const direct = repo.getTranscript(scope)
    const again = repo.getTranscript(scope)
    const page = repo.getPagination(scope)
    const msg = repo.getMessage(scope, "msg_1")
    expect(projectSpy).toHaveBeenCalledTimes(0)
    expect(again).toBe(direct)
    expect(direct).toBe(seen[0])
    expect(page.sessionID).toBe(SESSION)
    expect(msg?.id).toBe("msg_1")

    releaseA()
    releaseB()
    repo.destroy()
  })

  test("seeded Query data projects once across readers until data changes", () => {
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
    })
    // Seed InfiniteData without going through apply (no paint/diagnostics projection).
    const page = transportPage(
      [
        { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "a")] },
        { info: assistantMessage("msg_2"), parts: [textPart("p2", "msg_2", "b")] },
      ],
      { complete: true },
    )
    // Build canonical via one apply on a throwaway repo path: merge through apply once.
    repo.apply(scope, { type: "http-page", purpose: "initial", page })
    // Drop projection cache only (notify) by applying a no-op-ish path: purge cache via destroy-less
    // re-read after forcing cache miss — use a second repository on the same client.
    repo.destroy()
    const repo2 = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
    })
    projectSpy.mockClear()
    const a = repo2.getTranscript(scope)
    const b = repo2.getTranscript(scope)
    const c = repo2.getTranscript(scope)
    expect(projectSpy).toHaveBeenCalledTimes(1)
    expect(b).toBe(a)
    expect(c).toBe(a)
    expect(a.messageOrder).toEqual(["msg_1", "msg_2"])
    repo2.destroy()
  })

  test("new data reference reprojects once; unrelated message refs stay stable", () => {
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage(
        [
          { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "a")] },
          { info: assistantMessage("msg_2"), parts: [textPart("p2", "msg_2", "b")] },
        ],
        { complete: true },
      ),
    })
    const before = repo.getTranscript(scope)

    projectSpy.mockClear()
    repo.apply(scope, {
      type: "sse-event",
      event: {
        type: "message.part.updated",
        properties: { part: textPart("p2", "msg_2", "b2") },
      } as Event,
    })
    // apply invalidates + may project for paint/durable; warm readers share one result.
    const after = repo.getTranscript(scope)
    projectSpy.mockClear()
    const afterAgain = repo.getTranscript(scope)
    expect(projectSpy).toHaveBeenCalledTimes(0)
    expect(afterAgain).toBe(after)
    expect(after).not.toBe(before)
    expect((after.partsByMessageID.msg_2?.[0] as { text?: string })?.text).toBe("b2")
    expect(after.messagesByID.msg_1).toBe(before.messagesByID.msg_1)
    repo.destroy()
  })

  test("remove-message and empty canonical share one projection", () => {
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
    })
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage(
        [{ info: userMessage("msg_1"), parts: [textPart("p1", "msg_1")] }],
        { complete: true },
      ),
    })
    expect(repo.getTranscript(scope).messageOrder).toEqual(["msg_1"])
    repo.apply(scope, { type: "remove-message", messageID: "msg_1" })
    projectSpy.mockClear()
    const empty = repo.getTranscript(scope)
    const emptyAgain = repo.getTranscript(scope)
    expect(projectSpy).toHaveBeenCalledTimes(0)
    expect(emptyAgain).toBe(empty)
    expect(empty.messageOrder).toEqual([])
    repo.destroy()
  })

  test("runtime/generation/directory/session isolation with purge cleanup", () => {
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
    })
    const scopeA = { ...scope, sessionID: "ses_a" }
    const scopeB = { ...scope, sessionID: "ses_b" }
    const scopeGen = { ...scope, sessionID: "ses_a", generation: 2 }
    const scopeDir = { ...scope, sessionID: "ses_a", directory: "/other" }

    repo.apply(scopeA, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([{ info: userMessage("a1"), parts: [textPart("pa", "a1")] }], {
        complete: true,
      }),
    })
    repo.apply(scopeB, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([{ info: userMessage("b1"), parts: [textPart("pb", "b1")] }], {
        complete: true,
      }),
    })
    repo.apply(scopeGen, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([{ info: userMessage("g1"), parts: [textPart("pg", "g1")] }], {
        complete: true,
      }),
    })
    repo.apply(scopeDir, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([{ info: userMessage("d1"), parts: [textPart("pd", "d1")] }], {
        complete: true,
      }),
    })

    projectSpy.mockClear()
    expect(repo.getTranscript(scopeA).messageOrder).toEqual(["a1"])
    expect(repo.getTranscript(scopeB).messageOrder).toEqual(["b1"])
    expect(repo.getTranscript(scopeGen).messageOrder).toEqual(["g1"])
    expect(repo.getTranscript(scopeDir).messageOrder).toEqual(["d1"])
    // Warm cache from apply — zero extra projections.
    expect(projectSpy).toHaveBeenCalledTimes(0)

    repo.purgeSession(scopeA)
    projectSpy.mockClear()
    const emptyA = repo.getTranscript(scopeA)
    const emptyA2 = repo.getTranscript(scopeA)
    expect(emptyA.messageOrder).toEqual([])
    expect(emptyA2).toBe(emptyA)
    expect(repo.getTranscript(scopeB).messageOrder).toEqual(["b1"])
    // emptyTranscript short-circuits projectFlat; scopeB stays cached
    expect(projectSpy).toHaveBeenCalledTimes(0)

    repo.purgeGeneration(TRANSPORT, GENERATION)
    projectSpy.mockClear()
    const emptyB = repo.getTranscript(scopeB)
    const emptyB2 = repo.getTranscript(scopeB)
    expect(emptyB.messageOrder).toEqual([])
    expect(emptyB2).toBe(emptyB)
    expect(repo.getTranscript(scopeGen).messageOrder).toEqual(["g1"])
    expect(projectSpy).toHaveBeenCalledTimes(0)

    // scopeGen (generation 2) survived purgeGeneration(1); destroy clears
    // projection maps only — Query data remains for a new repository instance.
    repo.destroy()
    const repo2 = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: 2,
    })
    const scopeGenOnly = { ...scopeGen }
    projectSpy.mockClear()
    expect(repo2.getTranscript(scopeGenOnly).messageOrder).toEqual(["g1"])
    expect(projectSpy).toHaveBeenCalledTimes(1)
    expect(repo2.getTranscript(scopeGenOnly)).toBe(repo2.getTranscript(scopeGenOnly))
    expect(projectSpy).toHaveBeenCalledTimes(1)
    repo2.destroy()
  })
})
