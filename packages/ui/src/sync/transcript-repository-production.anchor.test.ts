import { beforeEach, describe, expect, test, vi } from "vitest"

import type { TranscriptTransportPage } from "./transcript-repository"

const { fetchPage } = vi.hoisted(() => ({
  fetchPage: vi.fn<(input: { cursor?: string }) => Promise<TranscriptTransportPage>>(),
}))

vi.mock("./session-projection-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-projection-api")>()
  return { ...actual, fetchSessionProjectionPage: fetchPage }
})

const { extendInitialPageToAuthoredUserTurn, INITIAL_ANCHOR_SCAN_EXTRA_PAGES } = await import(
  "./transcript-repository-production"
)

const record = (id: string, role: "user" | "assistant", created: number) => ({
  info: { id, sessionID: "ses_child", role, time: { created } },
  parts: [{ id: `${id}:text:0`, sessionID: "ses_child", messageID: id, type: "text", text: id }],
}) as unknown as TranscriptTransportPage["records"][number]

const assistants = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => record(`msg_a${from + index}`, "assistant", from + index))

const input = { sessionID: "ses_child", directory: "/repo", signal: new AbortController().signal }

describe("extendInitialPageToAuthoredUserTurn", () => {
  beforeEach(() => {
    fetchPage.mockReset()
  })

  test("walks older pages until the authored user anchor of a long turn appears", async () => {
    fetchPage.mockResolvedValueOnce({
      records: [record("msg_u0", "user", 0), ...assistants(1, 2)],
      cursor: undefined,
      complete: true,
      turnCount: 1,
    })

    const page = await extendInitialPageToAuthoredUserTurn(
      { records: assistants(3, 20), cursor: "cur_1", complete: false, turnCount: 0 },
      input,
    )

    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(fetchPage.mock.calls[0]![0]).toMatchObject({ cursor: "cur_1", directory: "/repo" })
    expect(page.records.map((entry) => entry.info.id)).toEqual([
      "msg_u0",
      ...assistants(1, 22).map((entry) => entry.info.id),
    ])
    expect(page).toMatchObject({ turnCount: 1, complete: true, cursor: undefined })
  })

  test("leaves anchored pages untouched", async () => {
    const anchored: TranscriptTransportPage = {
      records: [record("msg_u9", "user", 9), ...assistants(10, 3)],
      cursor: "cur_1",
      complete: false,
      turnCount: 1,
    }
    expect(await extendInitialPageToAuthoredUserTurn(anchored, input)).toBe(anchored)
    expect(fetchPage).not.toHaveBeenCalled()
  })

  test("stops at the scan bound and keeps the continuation cursor", async () => {
    let next = 0
    fetchPage.mockImplementation(async () => {
      next += 1
      return { records: assistants(-20 * next, 20), cursor: `cur_${next + 1}`, complete: false, turnCount: 0 }
    })

    const page = await extendInitialPageToAuthoredUserTurn(
      { records: assistants(0, 20), cursor: "cur_1", complete: false, turnCount: 0 },
      input,
    )

    expect(fetchPage).toHaveBeenCalledTimes(INITIAL_ANCHOR_SCAN_EXTRA_PAGES)
    expect(page.records).toHaveLength(20 * (INITIAL_ANCHOR_SCAN_EXTRA_PAGES + 1))
    expect(page).toMatchObject({ turnCount: 0, complete: false, cursor: `cur_${INITIAL_ANCHOR_SCAN_EXTRA_PAGES + 1}` })
  })
})
