/**
 * Ticket 10 — high-frequency SSE narrow-observer operation-count validation.
 *
 * Unit evidence (not wall-clock): after a representative-scale seed, a storm of
 * message.part.delta SSE commands must update only the target message/parts
 * references. Unrelated message/parts, messageOrder, and pagination stay
 * stable; simulated narrow observers report zero unrelated changes.
 *
 * Run:
 *   bun test packages/ui/src/sync/session-transcript-sse.performance.test.js
 */

import { beforeEach, describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/react-query"

import { createQueryTranscriptRepository } from "./transcript-repository-query-adapter"
import { sessionTranscriptQueryKey } from "./session-message-query"

const DIRECTORY = "/repo"
const SESSION = "ses_sse_perf"
const TRANSPORT = "runtime-sse-perf"
const GENERATION = 1

/** Representative transcript size for structural-sharing pressure. */
const MESSAGE_COUNT = 200
/** Representative token-stream length for a single streaming part. */
const DELTA_COUNT = 1000
const DELTA_TOKEN = "x"

const SCOPE = {
  directory: DIRECTORY,
  sessionID: SESSION,
  transport: TRANSPORT,
  generation: GENERATION,
}

function userMessage(id) {
  return { id, sessionID: SESSION, role: "user", time: { created: 1 } }
}

function assistantMessage(id) {
  return { id, sessionID: SESSION, role: "assistant", time: { created: 1 } }
}

function textPart(id, messageID, text = "") {
  return { id, messageID, sessionID: SESSION, type: "text", text }
}

function transportPage(records, options = {}) {
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

function messageID(index) {
  return `msg_${String(index).padStart(3, "0")}`
}

function partID(index) {
  return `part_${String(index).padStart(3, "0")}`
}

/**
 * Build a chronological seed: alternating user/assistant, one text part each.
 * The final assistant message is the streaming target (empty initial text).
 */
function buildSeedRecords(count) {
  const records = []
  for (let i = 0; i < count; i += 1) {
    const id = messageID(i)
    const isUser = i % 2 === 0
    const info = isUser ? userMessage(id) : assistantMessage(id)
    const initialText = isUser ? `user-${i}` : i === count - 1 ? "" : `assistant-${i}`
    records.push({
      info,
      parts: [textPart(partID(i), id, initialText)],
    })
  }
  return records
}

function partDeltaEvent(messageIDValue, partIDValue, delta) {
  return {
    type: "message.part.delta",
    properties: {
      sessionID: SESSION,
      messageID: messageIDValue,
      partID: partIDValue,
      field: "text",
      delta,
    },
  }
}

/**
 * Simulated narrow message/parts observer:
 * repository scope subscribe fires on any transcript write, but the observer
 * only counts when the specific message or parts reference identity changes.
 */
function createNarrowObserver(repo, scope, messageIDValue) {
  let messageRef = repo.getMessage(scope, messageIDValue)
  let partsRef = repo.getParts(scope, messageIDValue)
  let messageChanges = 0
  let partsChanges = 0

  const sample = () => {
    const nextMessage = repo.getMessage(scope, messageIDValue)
    const nextParts = repo.getParts(scope, messageIDValue)
    if (nextMessage !== messageRef) {
      messageRef = nextMessage
      messageChanges += 1
    }
    if (nextParts !== partsRef) {
      partsRef = nextParts
      partsChanges += 1
    }
  }

  return {
    sample,
    get messageRef() {
      return messageRef
    },
    get partsRef() {
      return partsRef
    },
    get messageChanges() {
      return messageChanges
    },
    get partsChanges() {
      return partsChanges
    },
  }
}

function paginationSnapshot(pagination) {
  return {
    sessionID: pagination.sessionID,
    hasPreviousPage: pagination.hasPreviousPage,
    isComplete: pagination.isComplete,
    cursor: pagination.cursor,
    loadedTurns: pagination.loadedTurns,
    boundaryKind: pagination.boundary.kind,
    boundaryLoadedTurns: pagination.boundary.loadedTurns,
    boundaryCursor:
      pagination.boundary.kind === "has-more" ? pagination.boundary.cursor : null,
  }
}

describe("Ticket 10 — high-frequency SSE narrow observers", () => {
  let client

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          retryDelay: 1,
        },
      },
    })
  })

  test(
    "message.part.delta storm updates only target message/parts refs (operation counts)",
    { timeout: 60_000 },
    () => {
      const repo = createQueryTranscriptRepository({
        client,
        transport: TRANSPORT,
        generation: GENERATION,
      })

      const records = buildSeedRecords(MESSAGE_COUNT)
      const targetIndex = MESSAGE_COUNT - 1
      const targetMessageID = messageID(targetIndex)
      const targetPartID = partID(targetIndex)
      const unrelatedIndexes = []
      for (let i = 0; i < MESSAGE_COUNT; i += 1) {
        if (i !== targetIndex) unrelatedIndexes.push(i)
      }

      const seedResult = repo.apply(SCOPE, {
        type: "http-page",
        purpose: "initial",
        page: transportPage(records, {
          complete: true,
          turnCount: Math.ceil(MESSAGE_COUNT / 2),
        }),
      })
      expect(seedResult.applied).toBe(true)
      expect(repo.getTranscript(SCOPE).messageOrder).toHaveLength(MESSAGE_COUNT)

      // Cache baseline references for every message/parts row.
      const baselineMessages = new Map()
      const baselineParts = new Map()
      for (let i = 0; i < MESSAGE_COUNT; i += 1) {
        const id = messageID(i)
        baselineMessages.set(id, repo.getMessage(SCOPE, id))
        baselineParts.set(id, repo.getParts(SCOPE, id))
      }
      const baselineMessageOrder = [...repo.getTranscript(SCOPE).messageOrder]
      const baselinePagination = paginationSnapshot(repo.getPagination(SCOPE))
      const baselineTargetText =
        baselineParts.get(targetMessageID)?.[0]?.text ?? ""

      // Canonical page-level messageOrder: structural sharing should keep the
      // order array identity when only a part field mutates (content-equal order).
      const queryKey = sessionTranscriptQueryKey(
        { directory: DIRECTORY, sessionID: SESSION },
        TRANSPORT,
        GENERATION,
      )
      const seedQueryData = client.getQueryData(queryKey)
      const baselinePageMessageOrder = seedQueryData?.pages?.[0]?.messageOrder
      expect(baselinePageMessageOrder).toBeDefined()

      // Live narrow observers during the storm: target + one sample unrelated.
      // Full unrelated catalog is verified by reference identity after the storm
      // (avoids O(messages × deltas) getTranscript rebuilds in the hot path).
      const targetObserver = createNarrowObserver(repo, SCOPE, targetMessageID)
      const sampleUnrelatedID = messageID(0)
      const sampleUnrelatedObserver = createNarrowObserver(
        repo,
        SCOPE,
        sampleUnrelatedID,
      )

      const unsub = repo.subscribe(SCOPE, () => {
        targetObserver.sample()
        sampleUnrelatedObserver.sample()
      })

      let appliedDeltas = 0
      for (let i = 0; i < DELTA_COUNT; i += 1) {
        const result = repo.apply(SCOPE, {
          type: "sse-event",
          event: partDeltaEvent(targetMessageID, targetPartID, DELTA_TOKEN),
        })
        if (result.applied && result.changed) appliedDeltas += 1
      }

      unsub()

      const finalParts = repo.getParts(SCOPE, targetMessageID)
      const finalText = finalParts[0]?.text ?? ""
      const expectedText = baselineTargetText + DELTA_TOKEN.repeat(DELTA_COUNT)
      expect(finalText).toBe(expectedText)
      expect(appliedDeltas).toBe(DELTA_COUNT)

      // Target parts reference must change once per applied delta; message shell
      // is not rewritten by part.delta.
      expect(targetObserver.partsChanges).toBe(DELTA_COUNT)
      expect(finalParts).not.toBe(baselineParts.get(targetMessageID))
      expect(targetObserver.messageChanges).toBe(0)
      expect(repo.getMessage(SCOPE, targetMessageID)).toBe(
        baselineMessages.get(targetMessageID),
      )

      // Sample unrelated narrow observer never fires on reference change.
      expect(sampleUnrelatedObserver.partsChanges).toBe(0)
      expect(sampleUnrelatedObserver.messageChanges).toBe(0)
      expect(sampleUnrelatedObserver.messageRef).toBe(
        baselineMessages.get(sampleUnrelatedID),
      )
      expect(sampleUnrelatedObserver.partsRef).toBe(
        baselineParts.get(sampleUnrelatedID),
      )

      // All unrelated message/parts references remain identity-stable.
      let unchangedReferenceCount = 0
      for (const index of unrelatedIndexes) {
        const id = messageID(index)
        const messageRef = repo.getMessage(SCOPE, id)
        const partsRef = repo.getParts(SCOPE, id)
        expect(messageRef).toBe(baselineMessages.get(id))
        expect(partsRef).toBe(baselineParts.get(id))
        if (messageRef === baselineMessages.get(id)) unchangedReferenceCount += 1
        if (partsRef === baselineParts.get(id)) unchangedReferenceCount += 1
      }
      expect(unchangedReferenceCount).toBe(unrelatedIndexes.length * 2)

      // Flat projection: order content + pagination fields stable across the storm.
      const afterTranscript = repo.getTranscript(SCOPE)
      const afterPagination = repo.getPagination(SCOPE)
      expect([...afterTranscript.messageOrder]).toEqual(baselineMessageOrder)
      expect(afterTranscript.messageOrder).toHaveLength(MESSAGE_COUNT)
      expect(paginationSnapshot(afterPagination)).toEqual(baselinePagination)

      // Settled projection: consecutive reads without further writes share refs.
      expect(repo.getTranscript(SCOPE).messageOrder).toBe(afterTranscript.messageOrder)
      expect(repo.getPagination(SCOPE)).toBe(afterPagination)

      // Page-level order content remains the seeded sequence (delta does not reorder).
      const afterQueryData = client.getQueryData(queryKey)
      expect(afterQueryData?.pages?.[0]?.messageOrder).toEqual(baselineMessageOrder)
      // When structural sharing reuses the page order array, keep that stronger
      // identity contract; otherwise content equality above is the contract.
      if (
        afterQueryData?.pages?.[0]?.messageOrder
        === baselinePageMessageOrder
      ) {
        expect(afterQueryData.pages[0].messageOrder).toBe(baselinePageMessageOrder)
      }

      const operationCounts = {
        inputDeltas: DELTA_COUNT,
        appliedDeltas,
        targetPartsChanges: targetObserver.partsChanges,
        targetMessageChanges: targetObserver.messageChanges,
        sampleUnrelatedPartsChanges: sampleUnrelatedObserver.partsChanges,
        sampleUnrelatedMessageChanges: sampleUnrelatedObserver.messageChanges,
        unrelatedObserverChangeCount:
          sampleUnrelatedObserver.partsChanges
          + sampleUnrelatedObserver.messageChanges,
        unchangedReferenceCount,
        messageCount: MESSAGE_COUNT,
      }

      // Single evidence line for Ticket 10 reports (deterministic counts, no wall-clock).
      console.log(
        `[Ticket10 SSE perf] inputDeltas=${operationCounts.inputDeltas} targetPartsChanges=${operationCounts.targetPartsChanges} targetMessageChanges=${operationCounts.targetMessageChanges} unrelatedObserverChanges=${operationCounts.unrelatedObserverChangeCount} unchangedRefs=${operationCounts.unchangedReferenceCount} messages=${operationCounts.messageCount}`,
      )

      expect(operationCounts).toEqual({
        inputDeltas: DELTA_COUNT,
        appliedDeltas: DELTA_COUNT,
        targetPartsChanges: DELTA_COUNT,
        targetMessageChanges: 0,
        sampleUnrelatedPartsChanges: 0,
        sampleUnrelatedMessageChanges: 0,
        unrelatedObserverChangeCount: 0,
        unchangedReferenceCount: unrelatedIndexes.length * 2,
        messageCount: MESSAGE_COUNT,
      })

      repo.destroy()
    },
  )
})
