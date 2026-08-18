import { beforeEach, describe, expect, test } from "bun:test"
import type { Event, Message, Part } from "@opencode-ai/sdk/v2/client"
import { QueryClient } from "@tanstack/react-query"

import {
  createQueryTranscriptRepository,
  type TranscriptQueryAdapterDeps,
} from "./transcript-repository-query-adapter"
import type { TranscriptTransportPage } from "./transcript-repository"
import { transcriptScope } from "./transcript-repository-runtime"

const DIRECTORY = "/repo"
const SESSION = "ses_1"
const TRANSPORT = "runtime-a"
const GENERATION = 1

function userMessage(id: string, created = 1): Message {
  return { id, sessionID: SESSION, role: "user", time: { created } } as Message
}

function assistantMessage(id: string, created = 2): Message {
  return { id, sessionID: SESSION, role: "assistant", time: { created }, finish: "stop" } as Message
}

function textPart(
  id: string,
  messageID: string,
  text = id,
  extra: Record<string, unknown> = {},
): Part {
  return { id, messageID, sessionID: SESSION, type: "text", text, ...extra } as Part
}

function slimTextPart(id: string, messageID: string, text: string): Part {
  return { id, messageID, sessionID: SESSION, type: "text", text, slim: true } as Part
}

function slimToolPart(id: string, messageID: string): Part {
  return {
    id,
    messageID,
    sessionID: SESSION,
    type: "tool",
    tool: "bash",
    callID: id,
    state: { status: "completed" },
    slim: true,
  } as unknown as Part
}

function fullToolPart(id: string, messageID: string, output: string): Part {
  return {
    id,
    messageID,
    sessionID: SESSION,
    type: "tool",
    tool: "bash",
    callID: id,
    state: { status: "completed", output },
  } as unknown as Part
}

function fullToolPartWithInput(
  id: string,
  messageID: string,
  input: Record<string, unknown>,
): Part {
  return {
    id,
    messageID,
    sessionID: SESSION,
    type: "tool",
    tool: "bash",
    callID: id,
    state: { status: "completed", input },
  } as unknown as Part
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

function partText(parts: readonly Part[]): string | undefined {
  return (parts.find((part) => part.type === "text") as { text?: string } | undefined)?.text
}

describe("transcript merge command-sequence replay", () => {
  let client: QueryClient
  const scope = transcriptScope(DIRECTORY, SESSION, {
    transport: TRANSPORT,
    generation: GENERATION,
  })

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 1 } },
    })
  })

  const createRepo = (
    options: Pick<TranscriptQueryAdapterDeps, "fetchMessage" | "fetcher"> = {},
  ) =>
    createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      ...options,
    })

  const seedBaseline = (repo: ReturnType<typeof createRepo>) => {
    const u1 = userMessage("msg_u1", 1)
    const a1 = assistantMessage("msg_a1", 2)
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage(
        [
          { info: u1, parts: [textPart("p_u1", "msg_u1", "先发的")] },
          { info: a1, parts: [textPart("p_a1", "msg_a1", "回复")] },
        ],
        { complete: true, turnCount: 1 },
      ),
    })
    return { u1, a1 }
  }

  const addOptimisticUser = (repo: ReturnType<typeof createRepo>) => {
    const u2 = userMessage("msg_u2", 3)
    repo.apply(scope, {
      type: "optimistic-add",
      message: u2,
      parts: [
        textPart("p_u2", "msg_u2", "我刚发的消息", { __openchamberOptimistic: true }),
      ],
    })
    return u2
  }

  // 根因: session-merge-strategy.ts:99-105 reconcile upsert + parts replace
  // 不感知 part 级 `__openchamberOptimistic`（诊断 A1 / A3）。
  // capturedLiveRevision 必须等于 liveRevision：0 vs 1 会走 stale backfill
  //（insert-only + skip-existing），乐观行反而被保住，复现不了 A 类。
  test(
    "replay: optimistic user row survives reconcile-page that carries an older server copy of the same message",
    () => {
      const repo = createRepo()
      const { u1, a1 } = seedBaseline(repo)
      const u2 = addOptimisticUser(repo)

      // Reconnect compensation shape: session-transcript-reconnect-compensation.ts:528-552.
      // Server copy of u2 is older (slim parts, different part id). Empty user
      // parts are protected in materializeSessionSnapshots and would not reproduce.
      repo.apply(scope, {
        type: "http-page",
        purpose: "reconcile-page",
        page: {
          records: [
            { info: u1, parts: [textPart("p_u1", "msg_u1", "先发的")] },
            { info: a1, parts: [textPart("p_a1", "msg_a1", "回复")] },
            { info: u2, parts: [slimTextPart("p_u2_server", "msg_u2", "")] },
          ],
          complete: false,
          cursor: undefined,
          turnCount: 0,
        },
        capturedLiveRevision: 0,
        liveRevision: 0,
      })

      expect(repo.getTranscript(scope).messageOrder).toContain("msg_u2")
      expect(partText(repo.getParts(scope, "msg_u2"))).toBe("我刚发的消息")
      repo.destroy()
    },
  )

  // 待决策：reset 是否应豁免乐观行（见诊断 A1）。本用例记录现状。
  test("replay: destructive reset clears optimistic rows (characterization)", () => {
    const repo = createRepo()
    const { u1, a1 } = seedBaseline(repo)
    addOptimisticUser(repo)

    repo.apply(scope, {
      type: "reset",
      page: transportPage(
        [
          { info: u1, parts: [textPart("p_u1", "msg_u1", "先发的")] },
          { info: a1, parts: [textPart("p_a1", "msg_a1", "回复")] },
        ],
        { complete: true, turnCount: 1 },
      ),
    })

    expect(repo.getTranscript(scope).messageOrder).not.toContain("msg_u2")
    expect(repo.getMessage(scope, "msg_u2")).toBeUndefined()
    repo.destroy()
  })

  // B 类在该序列下不复现：durable-seed → slim initial → materialize-snapshots
  // 会经 haveEquivalentPartSnapshots(JSON.stringify) 认出新正文并写入。
  // partPayloadEqual / stablePart（transcript-merge.ts:587-600 / :725-747）只在
  // SSE 路径；生产编辑回流走 materializeMessage，而 text 不在
  // EXACT_MATERIALIZATION_PART_TYPES（transcript-repository.ts:108，诊断 B3），
  // 需要「slim 页 + materializeMessage」才能卡住旧正文。
  test(
    "replay: materialized text replacement lands when durable seed holds an older full text",
    () => {
      const repo = createRepo()
      const asst1 = assistantMessage("msg_asst1", 2)

      repo.apply(scope, {
        type: "materialize-snapshots",
        records: [{ info: asst1, parts: [textPart("p1", "msg_asst1", "旧正文")] }],
      })
      repo.apply(scope, {
        type: "http-page",
        purpose: "initial",
        page: transportPage(
          [{ info: asst1, parts: [slimTextPart("p1", "msg_asst1", "摘要")] }],
          { complete: true, turnCount: 1 },
        ),
      })
      repo.apply(scope, {
        type: "materialize-snapshots",
        records: [{ info: asst1, parts: [textPart("p1", "msg_asst1", "编辑后的新正文")] }],
      })

      expect(partText(repo.getParts(scope, "msg_asst1"))).toBe("编辑后的新正文")
      repo.destroy()
    },
  )

  // 对照：text 类型不在 EXACT_MATERIALIZATION_PART_TYPES
  // （transcript-repository.ts:108），text slim 没有这条精确填充路径。
  test("replay: exact materialization fills slim tool part (control)", async () => {
    const asst1 = assistantMessage("msg_asst1", 2)
    const repo = createRepo({
      fetchMessage: async () => ({
        info: asst1,
        parts: [fullToolPart("p1", "msg_asst1", "exact tool output")],
      }),
    })

    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage(
        [{ info: asst1, parts: [slimToolPart("p1", "msg_asst1")] }],
        { complete: true, turnCount: 1 },
      ),
    })

    await repo.materializeMessage(scope, "msg_asst1")

    const part = repo.getParts(scope, "msg_asst1")[0] as {
      slim?: boolean
      state?: { output?: string }
    }
    expect(part.slim).not.toBe(true)
    expect(part.state?.output).toBe("exact tool output")
    repo.destroy()
  })

  // B3：EXACT_MATERIALIZATION_PART_TYPES（transcript-repository.ts:108-119）
  // 只含 {tool, reasoning, file}，不含 text → materializeMessage 对 slim text
  // 直接 no-op。这是编辑后正文停在海绵/旧文的候选根因。
  test(
    "replay: materializeMessage fills a slim text part from the exact host record (mirror of tool control)",
    async () => {
      const asst1 = assistantMessage("msg_asst1", 2)
      const repo = createRepo({
        fetchMessage: async () => ({
          info: asst1,
          parts: [textPart("p1", "msg_asst1", "exact full text body")],
        }),
      })

      repo.apply(scope, {
        type: "http-page",
        purpose: "initial",
        page: transportPage(
          [{ info: asst1, parts: [slimTextPart("p1", "msg_asst1", "摘要")] }],
          { complete: true, turnCount: 1 },
        ),
      })

      await repo.materializeMessage(scope, "msg_asst1")

      const part = repo.getParts(scope, "msg_asst1")[0] as {
        slim?: boolean
        text?: string
      }
      expect(part.slim).not.toBe(true)
      expect(part.text).toBe("exact full text body")
      repo.destroy()
    },
  )

  // B1 在该序列不复现。http-page → message.part.updated 确实走到
  // applySseToTranscriptData 的 stablePart / partsArraysEqualByRefOrContent
  //（transcript-merge.ts:697-747）和 partPayloadEqual（:587-600）。
  // 但真实 tool part 的 input 挂在 state 下；partPayloadEqual 用 !== 比 state
  // 引用。SSE 新 part 会分配新 state 对象，相等检查失败，draft 被保留，
  // input {a:2} 落地。reducer（transcript-event-reducer.ts:193-246）的
  // shouldPreserveExistingPart 只挡「终态被非终态覆盖」，两边都是 completed
  // 时放行。B1 真正的触发前置：改的是 top-level 且不在比较集里的字段
  //（tool / callID / title / mime / filename），同时 text/state/output/
  // metadata/time/url/slim 保持同一引用或同一原始值。
  test(
    "replay: SSE part update that only changes a field partPayloadEqual skips keeps the old reference",
    () => {
      const asst1 = assistantMessage("msg_asst1", 2)
      const repo = createRepo()

      repo.apply(scope, {
        type: "http-page",
        purpose: "initial",
        page: transportPage(
          [{ info: asst1, parts: [fullToolPartWithInput("pt1", "msg_asst1", { a: 1 })] }],
          { complete: true, turnCount: 1 },
        ),
      })

      repo.apply(scope, {
        type: "sse-event",
        event: {
          type: "message.part.updated",
          properties: {
            sessionID: SESSION,
            part: fullToolPartWithInput("pt1", "msg_asst1", { a: 2 }),
          },
        } as Event,
      })

      const part = repo.getParts(scope, "msg_asst1")[0] as {
        state?: { input?: { a?: number } }
      }
      expect(part.state?.input).toEqual({ a: 2 })
      repo.destroy()
    },
  )

  test("replay: hot ensureInitial refetches and merges as reconcile-page", async () => {
    let fetches = 0
    const repo = createRepo({
      fetcher: async () => {
        fetches += 1
        if (fetches === 1) {
          return transportPage(
            [{ info: userMessage("msg_u1", 1), parts: [textPart("p_u1", "msg_u1", "先发的")] }],
            { complete: true, turnCount: 1 },
          )
        }
        return transportPage(
          [
            { info: userMessage("msg_u1", 1), parts: [textPart("p_u1", "msg_u1", "先发的")] },
            { info: userMessage("msg_u2", 3), parts: [textPart("p_u2", "msg_u2", "后到的")] },
          ],
          { complete: true, turnCount: 2 },
        )
      },
    })

    await repo.ensureInitial(scope)
    await repo.ensureInitial(scope)

    expect(fetches).toBe(2)
    expect(repo.getTranscript(scope).messageOrder).toEqual(["msg_u1", "msg_u2"])
    expect(partText(repo.getParts(scope, "msg_u1"))).toBe("先发的")
    expect(partText(repo.getParts(scope, "msg_u2"))).toBe("后到的")
    repo.destroy()
  })

  test("replay: optimistic parts survive a hot ensureInitial reconcile-page", async () => {
    const u1 = userMessage("msg_u1", 1)
    const a1 = assistantMessage("msg_a1", 2)
    const repo = createRepo({
      fetcher: async () => transportPage(
        [
          { info: u1, parts: [textPart("p_u1", "msg_u1", "先发的")] },
          { info: a1, parts: [textPart("p_a1", "msg_a1", "回复")] },
          { info: userMessage("msg_u2", 3), parts: [slimTextPart("p_u2_server", "msg_u2", "")] },
        ],
        { complete: true, turnCount: 2 },
      ),
    })
    seedBaseline(repo)
    addOptimisticUser(repo)

    await repo.ensureInitial(scope)

    expect(repo.getTranscript(scope).messageOrder).toContain("msg_u2")
    expect(partText(repo.getParts(scope, "msg_u2"))).toBe("我刚发的消息")
    repo.destroy()
  })

  test("replay: SSE that advances revision during hot ensureInitial keeps live parts", async () => {
    const u1 = userMessage("msg_u1", 1)
    const a1 = assistantMessage("msg_a1", 2)
    let fetches = 0
    let releaseHot!: () => void
    const hotGate = new Promise<void>((resolve) => {
      releaseHot = resolve
    })
    let hotStarted!: () => void
    const hotStartedAt = new Promise<void>((resolve) => {
      hotStarted = resolve
    })
    const repo = createRepo({
      fetcher: async () => {
        fetches += 1
        if (fetches === 1) {
          return transportPage(
            [
              { info: u1, parts: [textPart("p_u1", "msg_u1", "先发的")] },
              { info: a1, parts: [textPart("p_a1", "msg_a1", "旧快照")] },
            ],
            { complete: true, turnCount: 1 },
          )
        }
        hotStarted()
        await hotGate
        return transportPage(
          [
            { info: u1, parts: [textPart("p_u1", "msg_u1", "先发的")] },
            { info: a1, parts: [textPart("p_a1", "msg_a1", "旧快照")] },
          ],
          { complete: true, turnCount: 1 },
        )
      },
    })

    await repo.ensureInitial(scope)
    const pending = repo.ensureInitial(scope)
    await hotStartedAt
    repo.apply(scope, {
      type: "sse-event",
      event: {
        type: "message.part.updated",
        properties: {
          sessionID: SESSION,
          part: textPart("p_a1", "msg_a1", "SSE 已推进"),
        },
      } as Event,
    })
    expect(repo.getTranscript(scope).liveRevision).toBeGreaterThan(0)
    releaseHot()
    await pending

    expect(fetches).toBe(2)
    expect(partText(repo.getParts(scope, "msg_a1"))).toBe("SSE 已推进")
    repo.destroy()
  })
})
