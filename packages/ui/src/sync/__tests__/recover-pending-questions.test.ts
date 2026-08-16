import { describe, expect, test } from "bun:test"

import {
  collectUnansweredQuestionToolIds,
  parseQuestionOutput,
  recoverPendingQuestionsIfNeeded,
  shouldRecoverPendingQuestions,
} from "../recover-pending-questions"

const answeredOutput = 'User has answered your questions: "Continue?"="Yes". You can now continue.'

const questionPart = (id: string, state: Record<string, unknown>) => ({
  id,
  type: "tool",
  tool: "question",
  state,
})

describe("parseQuestionOutput", () => {
  test("parses answered Q&A pairs", () => {
    expect(parseQuestionOutput(answeredOutput)).toEqual([{ question: "Continue?", answer: "Yes" }])
  })

  test("returns null when output is not an answer summary", () => {
    expect(parseQuestionOutput("still waiting")).toBeNull()
  })
})

describe("collectUnansweredQuestionToolIds", () => {
  test("collects pending and running question tools", () => {
    expect(collectUnansweredQuestionToolIds([
      { parts: [questionPart("q_pending", { status: "pending" })] },
      { parts: [questionPart("q_running", { status: "running" })] },
    ])).toEqual(["q_pending", "q_running"])
  })

  test("treats completed question tools without parseable Q&A as unanswered", () => {
    expect(collectUnansweredQuestionToolIds([
      { parts: [questionPart("q_completed_empty", { status: "completed" })] },
      { parts: [questionPart("q_completed_string", { status: "completed", output: "still waiting" })] },
    ])).toEqual(["q_completed_empty", "q_completed_string"])
  })

  test("ignores answered and errored question tools", () => {
    expect(collectUnansweredQuestionToolIds([
      { parts: [questionPart("q_answered", { status: "completed", output: answeredOutput })] },
      { parts: [questionPart("q_error", { status: "error", error: "failed" })] },
      { parts: [{ id: "bash_1", type: "tool", tool: "bash", state: { status: "running" } }] },
    ])).toEqual([])
  })
})

describe("shouldRecoverPendingQuestions", () => {
  test("recovers only when the viewed session has unanswered tools and an empty store", () => {
    expect(shouldRecoverPendingQuestions({
      sessionId: "ses_a",
      directory: "/repo",
      sessionQuestionCount: 0,
      unansweredToolIds: ["q_1"],
      attemptedKey: null,
    })).toEqual({ recover: true, attemptKey: "ses_a:q_1" })
  })

  test("does not recover when sessionQuestions already exist", () => {
    expect(shouldRecoverPendingQuestions({
      sessionId: "ses_a",
      directory: "/repo",
      sessionQuestionCount: 1,
      unansweredToolIds: ["q_1"],
      attemptedKey: null,
    }).recover).toBe(false)
  })

  test("does not recover the same unanswered ids twice", () => {
    expect(shouldRecoverPendingQuestions({
      sessionId: "ses_a",
      directory: "/repo",
      sessionQuestionCount: 0,
      unansweredToolIds: ["q_1"],
      attemptedKey: "ses_a:q_1",
    }).recover).toBe(false)
  })
})

describe("recoverPendingQuestionsIfNeeded", () => {
  test("calls resync once for the viewed session when the store is empty", async () => {
    const store = { id: "store" }
    const calls: Array<{ directory: string; store: unknown; sessionIds?: string[] }> = []

    const result = await recoverPendingQuestionsIfNeeded({
      sessionId: "ses_a",
      directory: "/repo",
      sessionQuestionCount: 0,
      messages: [{ parts: [questionPart("q_1", { status: "pending" })] }],
      attemptedKey: null,
      getStore: () => store,
      resync: async (directory, nextStore, sessionIds) => {
        calls.push({ directory, store: nextStore, sessionIds })
      },
    })

    expect(result).toEqual({ attemptedKey: "ses_a:q_1", recovered: true })
    expect(calls).toEqual([{ directory: "/repo", store, sessionIds: ["ses_a"] }])
  })

  test("does not call resync when sessionQuestions already exist", async () => {
    let called = 0
    const result = await recoverPendingQuestionsIfNeeded({
      sessionId: "ses_a",
      directory: "/repo",
      sessionQuestionCount: 1,
      messages: [{ parts: [questionPart("q_1", { status: "pending" })] }],
      attemptedKey: null,
      getStore: () => ({ id: "store" }),
      resync: async () => {
        called += 1
      },
    })
    expect(result.recovered).toBe(false)
    expect(called).toBe(0)
  })

  test("does not call resync again for the same unanswered tool ids", async () => {
    let called = 0
    const result = await recoverPendingQuestionsIfNeeded({
      sessionId: "ses_a",
      directory: "/repo",
      sessionQuestionCount: 0,
      messages: [{ parts: [questionPart("q_1", { status: "pending" })] }],
      attemptedKey: "ses_a:q_1",
      getStore: () => ({ id: "store" }),
      resync: async () => {
        called += 1
      },
    })
    expect(result.recovered).toBe(false)
    expect(called).toBe(0)
  })

  test("does not throw when list/resync fails", async () => {
    const result = await recoverPendingQuestionsIfNeeded({
      sessionId: "ses_a",
      directory: "/repo",
      sessionQuestionCount: 0,
      messages: [{ parts: [questionPart("q_1", { status: "pending" })] }],
      attemptedKey: null,
      getStore: () => ({ id: "store" }),
      resync: async () => {
        throw new Error("question.list failed: simulated")
      },
    })
    expect(result).toEqual({ attemptedKey: "ses_a:q_1", recovered: true })
  })
})
