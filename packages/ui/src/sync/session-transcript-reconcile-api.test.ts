import { afterEach, describe, expect, mock, test } from "bun:test"

import {
  SessionMessageHttpError,
  SessionMessagePageContractError,
} from "./session-message-query"

const fetchCalls: Array<{ url: string; init: unknown }> = []
let fetchImpl: (url: string, init?: unknown) => Promise<Response> = async () => {
  throw new Error("fetch not stubbed")
}

mock.module("../lib/runtime-fetch", () => ({
  runtimeFetch: async (input: string | URL | Request, init?: unknown) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    fetchCalls.push({ url, init })
    return fetchImpl(url, init)
  },
}))

const {
  assertSessionTranscriptReconcilePage,
  fetchSessionTranscriptReconcile,
} = await import("./session-transcript-reconcile-api")

afterEach(() => {
  fetchCalls.length = 0
  fetchImpl = async () => {
    throw new Error("fetch not stubbed")
  }
})

const validPage = (overrides: Record<string, unknown> = {}) => ({
  records: [
    {
      info: { id: "msg_1", role: "user", sessionID: "ses_1", time: { created: 1 } },
      parts: [{ id: "p1", messageID: "msg_1", type: "text", text: "hi" }],
    },
  ],
  anchorFound: true,
  capturedHeadMessageID: "msg_9",
  latestHeadMessageID: "msg_9",
  continuation: null,
  complete: true,
  resetRequired: false,
  scannedRecords: 1,
  responseBytes: 128,
  ...overrides,
})

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

describe("assertSessionTranscriptReconcilePage", () => {
  test("accepts a strict Host success page", () => {
    const page = assertSessionTranscriptReconcilePage(validPage())
    expect(page.records).toHaveLength(1)
    expect(page.records[0]!.info.id).toBe("msg_1")
    expect(page.complete).toBe(true)
    expect(page.resetRequired).toBe(false)
    expect(page.continuation).toBe(null)
  })

  test("rejects missing records array", () => {
    expect(() =>
      assertSessionTranscriptReconcilePage({ ...validPage(), records: undefined }),
    ).toThrow(SessionMessagePageContractError)
  })

  test("rejects complete=true with continuation", () => {
    expect(() =>
      assertSessionTranscriptReconcilePage(
        validPage({ complete: true, continuation: "ocr2.token" }),
      ),
    ).toThrow(/continuation=null/)
  })

  test("rejects resetRequired=true with continuation", () => {
    expect(() =>
      assertSessionTranscriptReconcilePage(
        validPage({ resetRequired: true, complete: true, continuation: "ocr2.token" }),
      ),
    ).toThrow(/continuation=null/)
  })

  test("rejects resetRequired=true without complete=true", () => {
    expect(() =>
      assertSessionTranscriptReconcilePage(
        validPage({ resetRequired: true, complete: false, continuation: null }),
      ),
    ).toThrow(/resetRequired=true requires complete=true/)
  })

  test("accepts resetRequired terminal page", () => {
    const page = assertSessionTranscriptReconcilePage(
      validPage({
        resetRequired: true,
        complete: true,
        continuation: null,
        records: [],
      }),
    )
    expect(page.resetRequired).toBe(true)
    expect(page.complete).toBe(true)
  })

  test("rejects complete=false without continuation", () => {
    expect(() =>
      assertSessionTranscriptReconcilePage(
        validPage({ complete: false, resetRequired: false, continuation: null }),
      ),
    ).toThrow(/complete=false requires non-empty continuation/)
  })

  test("accepts complete=false with non-empty continuation", () => {
    const page = assertSessionTranscriptReconcilePage(
      validPage({
        complete: false,
        resetRequired: false,
        continuation: "ocr2.token",
      }),
    )
    expect(page.complete).toBe(false)
    expect(page.continuation).toBe("ocr2.token")
  })

  test("rejects negative or non-integer scannedRecords / responseBytes", () => {
    expect(() =>
      assertSessionTranscriptReconcilePage(validPage({ scannedRecords: -1 })),
    ).toThrow(/scannedRecords must be a non-negative integer/)
    expect(() =>
      assertSessionTranscriptReconcilePage(validPage({ scannedRecords: 1.5 })),
    ).toThrow(/scannedRecords must be a non-negative integer/)
    expect(() =>
      assertSessionTranscriptReconcilePage(validPage({ responseBytes: -2 })),
    ).toThrow(/responseBytes must be a non-negative integer/)
    expect(() =>
      assertSessionTranscriptReconcilePage(validPage({ responseBytes: 3.14 })),
    ).toThrow(/responseBytes must be a non-negative integer/)
  })

  test("rejects record without info.id", () => {
    expect(() =>
      assertSessionTranscriptReconcilePage(
        validPage({
          records: [{ info: { role: "user" }, parts: [] }],
        }),
      ),
    ).toThrow(/info\.id/)
  })
})

describe("fetchSessionTranscriptReconcile", () => {
  test("requires exactly one of anchor or continuation", async () => {
    await expect(
      fetchSessionTranscriptReconcile({
        sessionID: "ses_1",
        directory: "/repo",
      }),
    ).rejects.toThrow(SessionMessagePageContractError)

    await expect(
      fetchSessionTranscriptReconcile({
        sessionID: "ses_1",
        directory: "/repo",
        anchor: "a",
        continuation: "c",
      }),
    ).rejects.toThrow(SessionMessagePageContractError)
  })

  test("GET reconcile with directory + anchor", async () => {
    fetchImpl = async () => jsonResponse(validPage())
    const page = await fetchSessionTranscriptReconcile({
      sessionID: "ses/a b",
      directory: "/repo",
      anchor: "msg_anchor",
      maxRetries: 0,
    })
    expect(page.anchorFound).toBe(true)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]!.url).toContain(
      `/api/openchamber/sessions/${encodeURIComponent("ses/a b")}/messages/reconcile`,
    )
    const init = fetchCalls[0]!.init as { query?: Record<string, string> }
    expect(init.query?.directory).toBe("/repo")
    expect(init.query?.anchor).toBe("msg_anchor")
    expect(init.query?.continuation).toBeUndefined()
  })

  test("GET reconcile with continuation only", async () => {
    fetchImpl = async () =>
      jsonResponse(
        validPage({
          complete: true,
          continuation: null,
          records: [],
        }),
      )
    await fetchSessionTranscriptReconcile({
      sessionID: "ses_1",
      directory: "/repo",
      continuation: "ocr2.token",
      maxRetries: 0,
    })
    const init = fetchCalls[0]!.init as { query?: Record<string, string> }
    expect(init.query?.continuation).toBe("ocr2.token")
    expect(init.query?.anchor).toBeUndefined()
  })

  test("4xx fails immediately without retry", async () => {
    let calls = 0
    fetchImpl = async () => {
      calls += 1
      return jsonResponse({ error: "bad" }, 400)
    }
    await expect(
      fetchSessionTranscriptReconcile({
        sessionID: "ses_1",
        directory: "/repo",
        anchor: "a",
        maxRetries: 2,
        sleep: async () => {},
      }),
    ).rejects.toThrow(SessionMessageHttpError)
    expect(calls).toBe(1)
  })

  test("contract error fails immediately without retry", async () => {
    let calls = 0
    fetchImpl = async () => {
      calls += 1
      return jsonResponse({ records: "nope" })
    }
    await expect(
      fetchSessionTranscriptReconcile({
        sessionID: "ses_1",
        directory: "/repo",
        anchor: "a",
        maxRetries: 2,
        sleep: async () => {},
      }),
    ).rejects.toThrow(SessionMessagePageContractError)
    expect(calls).toBe(1)
  })

  test("502 retries up to 2 times then succeeds", async () => {
    let calls = 0
    fetchImpl = async () => {
      calls += 1
      if (calls <= 2) return jsonResponse({ error: "bad gateway" }, 502)
      return jsonResponse(validPage())
    }
    const page = await fetchSessionTranscriptReconcile({
      sessionID: "ses_1",
      directory: "/repo",
      anchor: "a",
      maxRetries: 2,
      sleep: async () => {},
    })
    expect(page.complete).toBe(true)
    expect(calls).toBe(3)
  })

  test("502 exhausts max retries", async () => {
    let calls = 0
    fetchImpl = async () => {
      calls += 1
      return jsonResponse({ error: "bad gateway" }, 502)
    }
    await expect(
      fetchSessionTranscriptReconcile({
        sessionID: "ses_1",
        directory: "/repo",
        anchor: "a",
        maxRetries: 2,
        sleep: async () => {},
      }),
    ).rejects.toThrow(SessionMessageHttpError)
    // 1 initial + 2 retries
    expect(calls).toBe(3)
  })

  test("network error is retryable", async () => {
    let calls = 0
    fetchImpl = async () => {
      calls += 1
      if (calls === 1) throw new Error("Failed to fetch")
      return jsonResponse(validPage())
    }
    await fetchSessionTranscriptReconcile({
      sessionID: "ses_1",
      directory: "/repo",
      anchor: "a",
      maxRetries: 2,
      sleep: async () => {},
    })
    expect(calls).toBe(2)
  })
})
