import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

mock.restore()

import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from "../lib/runtime-url"

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window
const here = dirname(fileURLToPath(import.meta.url))

type FetchCall = {
  url: URL
  method: string
  body: unknown
}

const SESSION = "ses_1"
const MESSAGE = "msg_user"

const REVERT = {
  messageID: MESSAGE,
  snapshot: "snap_1",
  files: [
    { file: "src/a.ts", status: "modified", additions: 2, deletions: 1, patch: "diff" },
    { file: "README.md", status: "added", additions: 4, deletions: 0, patch: "diff" },
  ],
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("official revert stage / clear / commit (ticket 09)", () => {
  let previousResolver: ReturnType<typeof getRuntimeUrlResolver>
  let calls: FetchCall[]
  let responseImpl: (call: FetchCall) => Promise<Response>

  beforeEach(() => {
    previousResolver = getRuntimeUrlResolver()
    configureRuntimeUrlResolver({ apiBaseUrl: "http://127.0.0.1:57123" })
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "https://app.example", href: "https://app.example/" } },
    })
    calls = []
    responseImpl = async (call) => {
      if (call.url.pathname.endsWith("/revert/stage")) return jsonResponse({ data: REVERT })
      return new Response(null, { status: 204 })
    }
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      let body: unknown = null
      try {
        const text = await request.clone().text()
        body = text ? JSON.parse(text) : null
      } catch {
        body = null
      }
      const call = { url: new URL(request.url), method: request.method, body }
      calls.push(call)
      return responseImpl(call)
    }) as typeof fetch
  })

  afterEach(() => {
    setRuntimeUrlResolver(previousResolver)
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow })
    globalThis.fetch = originalFetch
  })

  afterAll(() => {
    mock.restore()
  })

  test("stage POSTs /api/session/:encodedSessionID/revert/stage with messageID and files:true", async () => {
    const { postSessionRevertStage, revertFilePaths } = await import("./session-revert-api")
    const revert = await postSessionRevertStage({
      sessionID: "ses/a b",
      directory: "/repo a",
      messageID: MESSAGE,
      files: true,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("POST")
    expect(calls[0]!.url.pathname).toBe(`/api/session/${encodeURIComponent("ses/a b")}/revert/stage`)
    expect(calls[0]!.url.searchParams.get("directory")).toBe("/repo a")
    expect(calls[0]!.body).toEqual({ messageID: MESSAGE, files: true })
    expect(revert.messageID).toBe(MESSAGE)
    expect(revertFilePaths(revert)).toEqual(["src/a.ts", "README.md"])
  })

  test("stage HTTP non-2xx / malformed JSON throw instead of empty success", async () => {
    const { postSessionRevertStage } = await import("./session-revert-api")
    responseImpl = async () => new Response("nope", { status: 500 })
    await expect(postSessionRevertStage({
      sessionID: SESSION,
      directory: "/repo",
      messageID: MESSAGE,
    })).rejects.toThrow()

    responseImpl = async () =>
      new Response("not-json", { status: 200, headers: { "content-type": "application/json" } })
    await expect(postSessionRevertStage({
      sessionID: SESSION,
      directory: "/repo",
      messageID: MESSAGE,
    })).rejects.toThrow()
  })

  test("stage 409 becomes a busy error, not an empty success", async () => {
    const { postSessionRevertStage, isSessionRevertBusyError } = await import("./session-revert-api")
    responseImpl = async () => new Response("busy", { status: 409 })
    try {
      await postSessionRevertStage({ sessionID: SESSION, directory: "/repo", messageID: MESSAGE })
      expect(true).toBe(false)
    } catch (error) {
      expect(isSessionRevertBusyError(error)).toBe(true)
    }
  })

  test("clear POSTs /revert/clear and treats 204 as success", async () => {
    const { postSessionRevertClear } = await import("./session-revert-api")
    await postSessionRevertClear({ sessionID: "ses/a b", directory: "/repo a" })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("POST")
    expect(calls[0]!.url.pathname).toBe(`/api/session/${encodeURIComponent("ses/a b")}/revert/clear`)
    expect(calls[0]!.url.searchParams.get("directory")).toBe("/repo a")
  })

  test("clear HTTP non-2xx throws", async () => {
    const { postSessionRevertClear } = await import("./session-revert-api")
    responseImpl = async () => new Response("nope", { status: 500 })
    await expect(postSessionRevertClear({ sessionID: SESSION, directory: "/repo" })).rejects.toThrow()
  })

  test("commit POSTs /revert/commit", async () => {
    const { postSessionRevertCommit } = await import("./session-revert-api")
    await postSessionRevertCommit({ sessionID: SESSION, directory: "/repo" })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("POST")
    expect(calls[0]!.url.pathname).toBe(`/api/session/${SESSION}/revert/commit`)
    expect(calls[0]!.url.searchParams.get("directory")).toBe("/repo")
  })

  test("commit HTTP non-2xx throws so send cannot pretend success", async () => {
    const { postSessionRevertCommit } = await import("./session-revert-api")
    responseImpl = async () => new Response("nope", { status: 500 })
    await expect(postSessionRevertCommit({ sessionID: SESSION, directory: "/repo" })).rejects.toThrow()
  })
})

describe("ticket 09 source contracts", () => {
  test("client revert/unrevert go through stage/clear, not SDK session.revert/unrevert", () => {
    const clientSource = readFileSync(join(here, "../lib/opencode/client.ts"), "utf8")
    expect(clientSource.includes("postSessionRevertStage")).toBe(true)
    expect(clientSource.includes("postSessionRevertClear")).toBe(true)
    expect(clientSource.includes("this.client.session.revert(")).toBe(false)
    expect(clientSource.includes("this.client.session.unrevert(")).toBe(false)
  })

  test("session-actions revert/unrevert use official stage/clear and do not delete the transcript tail", () => {
    const actionsSource = readFileSync(join(here, "session-actions.ts"), "utf8")
    expect(actionsSource.includes("postSessionRevertStage")).toBe(true)
    expect(actionsSource.includes("postSessionRevertClear") || actionsSource.includes("unrevertSession(")).toBe(true)
    expect(actionsSource.includes("isSessionRevertBusyError") || actionsSource.includes("sessionRevertBusyError")).toBe(true)
    const revertFn = actionsSource.slice(actionsSource.indexOf("export async function revertToMessage"))
    const revertBody = revertFn.slice(0, revertFn.indexOf("function removeSessionMessageFromStore"))
    expect(revertBody.includes("removeSessionMessageFromStore(")).toBe(false)
    expect(revertBody.includes('type: "remove-message"')).toBe(false)
    expect(revertBody.includes("sdk().session.revert")).toBe(false)
  })

  test("new send commits a staged revert before prompt", () => {
    const uiSource = readFileSync(join(here, "session-ui-store.ts"), "utf8")
    const clientSource = readFileSync(join(here, "../lib/opencode/client.ts"), "utf8")
    expect(
      uiSource.includes("commitStagedRevertBeforeSend")
      || clientSource.includes("postSessionRevertCommit"),
    ).toBe(true)
  })

  test("busy and file-path copy go through locale keys", () => {
    const en = readFileSync(join(here, "../lib/i18n/messages/en.ts"), "utf8")
    const zhCN = readFileSync(join(here, "../lib/i18n/messages/zh-CN.ts"), "utf8")
    const dock = readFileSync(join(here, "../components/chat/ChatInput.tsx"), "utf8")
    expect(en.includes("'chat.revert.toast.busy'")).toBe(true)
    expect(en.includes("'chat.revertPopover.files'")).toBe(true)
    expect(zhCN.includes("'chat.revert.toast.busy': '会话进行中，无法撤销'")).toBe(true)
    expect(dock.includes("chat.revertPopover.files")).toBe(true)
    expect(dock.includes("revertFilePaths") || dock.includes("revert.files")).toBe(true)
  })
})
