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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("permission last-match + saved deny (ticket 10)", () => {
  test("last matching rule wins; unmatched defaults to ask", async () => {
    const { evaluatePermissionRule, evaluatePermissionEffect } = await import("./permission-rules")
    const rules = [
      { action: "bash", resource: "*", effect: "ask" as const },
      { action: "bash", resource: "rm *", effect: "deny" as const },
      { action: "bash", resource: "rm -rf /tmp", effect: "allow" as const },
    ]
    expect(evaluatePermissionRule("bash", "rm -rf /tmp", rules).effect).toBe("allow")
    expect(evaluatePermissionRule("bash", "rm notes.txt", rules).effect).toBe("deny")
    expect(evaluatePermissionRule("bash", "ls", rules).effect).toBe("ask")
    expect(evaluatePermissionRule("read", "src/a.ts", rules).effect).toBe("ask")
    expect(evaluatePermissionEffect("bash", ["ls"], rules)).toBe("ask")
  })

  test("configured deny is not overridden by a later saved allow", async () => {
    const { evaluatePermissionEffect } = await import("./permission-rules")
    const configured = [{ action: "edit", resource: "secrets/**", effect: "deny" as const }]
    const saved = [{ action: "edit", resource: "secrets/**" }]
    expect(evaluatePermissionEffect("edit", ["secrets/key.env"], configured, saved)).toBe("deny")
  })

  test("saved allow can satisfy a configured ask", async () => {
    const { evaluatePermissionEffect } = await import("./permission-rules")
    const configured = [{ action: "bash", resource: "*", effect: "ask" as const }]
    const saved = [{ action: "bash", resource: "npm test" }]
    expect(evaluatePermissionEffect("bash", ["npm test"], configured, saved)).toBe("allow")
    expect(evaluatePermissionEffect("bash", ["rm -rf /"], configured, saved)).toBe("ask")
  })

  test("toPermissionRuleset keeps official array order and flattens a V1 tool map", async () => {
    const { toPermissionRuleset, displayPermissionRulesLastMatch } = await import("./permission-rules")
    const official = [
      { action: "read", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "ask" },
    ]
    expect(displayPermissionRulesLastMatch(official)).toEqual(official)
    expect(toPermissionRuleset({
      bash: { "*": "ask", "rm *": "deny" },
      read: "allow",
    })).toEqual([
      { action: "bash", resource: "*", effect: "ask" },
      { action: "bash", resource: "rm *", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
    ])
  })
})

describe("official saved / permission reply / form HTTP (ticket 10)", () => {
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
    responseImpl = async () => new Response(null, { status: 204 })
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

  test("list GET /api/permission/saved?projectID= and parses data[]", async () => {
    const { listPermissionSaved } = await import("./permission-saved-api")
    responseImpl = async () => jsonResponse({
      data: [{ id: "psv_1", projectID: "prj_1", action: "bash", resource: "npm test" }],
    })
    const items = await listPermissionSaved({ projectID: "prj_1" })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("GET")
    expect(calls[0]!.url.pathname).toBe("/api/permission/saved")
    expect(calls[0]!.url.searchParams.get("projectID")).toBe("prj_1")
    expect(items).toEqual([{ id: "psv_1", projectID: "prj_1", action: "bash", resource: "npm test" }])
  })

  test("saved list HTTP non-2xx / malformed JSON throw instead of empty success", async () => {
    const { listPermissionSaved } = await import("./permission-saved-api")
    responseImpl = async () => new Response("nope", { status: 500 })
    await expect(listPermissionSaved({ projectID: "prj_1" })).rejects.toThrow()

    responseImpl = async () =>
      new Response("not-json", { status: 200, headers: { "content-type": "application/json" } })
    await expect(listPermissionSaved({ projectID: "prj_1" })).rejects.toThrow()
  })

  test("delete DELETE /api/permission/saved/:encodedId and treats 204 as success", async () => {
    const { deletePermissionSaved } = await import("./permission-saved-api")
    await deletePermissionSaved({ id: "psv/a b" })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("DELETE")
    expect(calls[0]!.url.pathname).toBe(`/api/permission/saved/${encodeURIComponent("psv/a b")}`)
  })

  test("delete HTTP non-2xx throws", async () => {
    const { deletePermissionSaved } = await import("./permission-saved-api")
    responseImpl = async () => new Response("nope", { status: 500 })
    await expect(deletePermissionSaved({ id: "psv_1" })).rejects.toThrow()
  })

  test("permission reply POSTs /api/session/:id/permission/:id/reply with once|always|reject", async () => {
    const { postSessionPermissionReply } = await import("./session-permission-api")
    await postSessionPermissionReply({
      sessionID: "ses/a b",
      requestID: "per/1",
      directory: "/repo a",
      reply: "always",
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("POST")
    expect(calls[0]!.url.pathname).toBe(
      `/api/session/${encodeURIComponent("ses/a b")}/permission/${encodeURIComponent("per/1")}/reply`,
    )
    expect(calls[0]!.url.searchParams.get("directory")).toBe("/repo a")
    expect(calls[0]!.body).toEqual({ reply: "always" })
  })

  test("permission reply HTTP non-2xx throws instead of empty success", async () => {
    const { postSessionPermissionReply } = await import("./session-permission-api")
    responseImpl = async () => new Response("nope", { status: 500 })
    await expect(postSessionPermissionReply({
      sessionID: "ses_1",
      requestID: "per_1",
      reply: "once",
    })).rejects.toThrow()
  })

  test("form list / reply / cancel use official session form routes", async () => {
    const { listSessionForms, postSessionFormReply, postSessionFormCancel } = await import("./session-form-api")
    responseImpl = async (call) => {
      if (call.method === "GET") {
        return jsonResponse({
          data: [{
            id: "frm_1",
            sessionID: "ses_1",
            title: "Confirm",
            fields: [{ key: "ok", type: "boolean", title: "OK" }],
          }],
        })
      }
      return new Response(null, { status: 204 })
    }
    const forms = await listSessionForms({ sessionID: "ses/a b", directory: "/repo a" })
    expect(calls[0]!.method).toBe("GET")
    expect(calls[0]!.url.pathname).toBe(`/api/session/${encodeURIComponent("ses/a b")}/form`)
    expect(forms[0]!.id).toBe("frm_1")

    await postSessionFormReply({
      sessionID: "ses/a b",
      formID: "frm_1",
      directory: "/repo a",
      answer: { ok: true },
    })
    expect(calls[1]!.method).toBe("POST")
    expect(calls[1]!.url.pathname).toBe(`/api/session/${encodeURIComponent("ses/a b")}/form/frm_1/reply`)
    expect(calls[1]!.body).toEqual({ answer: { ok: true } })

    await postSessionFormCancel({ sessionID: "ses/a b", formID: "frm_1", directory: "/repo a" })
    expect(calls[2]!.url.pathname).toBe(`/api/session/${encodeURIComponent("ses/a b")}/form/frm_1/cancel`)
  })

  test("form HTTP non-2xx / malformed JSON throw instead of empty success", async () => {
    const { listSessionForms, postSessionFormReply, postSessionFormCancel } = await import("./session-form-api")
    responseImpl = async () => new Response("nope", { status: 500 })
    await expect(listSessionForms({ sessionID: "ses_1" })).rejects.toThrow()
    await expect(postSessionFormReply({ sessionID: "ses_1", formID: "frm_1", answer: {} })).rejects.toThrow()
    await expect(postSessionFormCancel({ sessionID: "ses_1", formID: "frm_1" })).rejects.toThrow()

    responseImpl = async () =>
      new Response("not-json", { status: 200, headers: { "content-type": "application/json" } })
    await expect(listSessionForms({ sessionID: "ses_1" })).rejects.toThrow()
  })
})

describe("form store + retry action (ticket 10)", () => {
  test("form.created upserts current-session pending; replied/cancelled drop it", async () => {
    const { applySessionFormLiveEvent, useSessionFormStore } = await import("./session-form-store")
    useSessionFormStore.setState({ forms: {} })
    expect(applySessionFormLiveEvent({
      type: "form.created",
      properties: {
        form: {
          id: "frm_1",
          sessionID: "ses_1",
          title: "Confirm",
          fields: [{ key: "ok", type: "boolean" }],
        },
      },
    })).toBe(true)
    expect(useSessionFormStore.getState().formsForSession("ses_1").map((form) => form.id)).toEqual(["frm_1"])
    expect(useSessionFormStore.getState().formsForSession("ses_other")).toEqual([])

    applySessionFormLiveEvent({
      type: "form.replied",
      properties: { id: "frm_1", sessionID: "ses_1", answer: { ok: true } },
    })
    expect(useSessionFormStore.getState().formsForSession("ses_1")).toEqual([])
  })

  test("retry+action is a quota/account prompt, not an ordinary error toast", async () => {
    const { isSessionRetryAction, resolveRetryActionCopy, shouldToastSessionRetryAsError } = await import("./session-retry-action")
    const status = {
      type: "retry" as const,
      attempt: 2,
      message: "rate limited",
      next: 3,
      action: {
        reason: "free_tier_limit",
        provider: "opencode",
        title: "Usage exceeded",
        message: "Free tier used up",
        label: "Upgrade",
        link: "https://example.test/upgrade",
      },
    }
    expect(isSessionRetryAction(status)).toBe(true)
    expect(shouldToastSessionRetryAsError(status)).toBe(false)
    expect(shouldToastSessionRetryAsError({ type: "retry", message: "network" })).toBe(true)
    const copy = resolveRetryActionCopy(status, (key) => key)
    expect(copy).toEqual({
      title: "Usage exceeded",
      message: "Free tier used up",
      label: "Upgrade",
      link: "https://example.test/upgrade",
    })
  })
})

describe("ticket 10 source contracts", () => {
  test("permission reply goes through official session reply, not SDK permission.reply", () => {
    const actionsSource = readFileSync(join(here, "session-actions.ts"), "utf8")
    const replyFn = actionsSource.slice(actionsSource.indexOf("export async function respondToPermission"))
    const replyBody = replyFn.slice(0, replyFn.indexOf("export async function respondToQuestion"))
    expect(replyBody.includes("postSessionPermissionReply")).toBe(true)
    expect(replyBody.includes("permission.reply(")).toBe(false)
    expect(replyBody.includes("clearSessionPermissionsFromChildStores")).toBe(true)
  })

  test("reject clears the whole session pending set, not only the replied id", () => {
    const actionsSource = readFileSync(join(here, "session-actions.ts"), "utf8")
    const helper = actionsSource.slice(actionsSource.indexOf("function clearSessionPermissionsFromChildStores"))
    const helperBody = helper.slice(0, helper.indexOf("function getRequestReplyClient"))
    expect(helperBody.includes("delete next[sessionId]") || helperBody.includes("delete next[sessionID]")).toBe(true)
    expect(helperBody.includes("request.id !== requestId")).toBe(false)
  })

  test("settings list/delete saved permissions; agents display last-match, not a V1 tool map", () => {
    const agents = readFileSync(join(here, "../components/sections/agents/AgentsPage.tsx"), "utf8")
    const saved = readFileSync(join(here, "../components/sections/agents/SavedPermissionsSection.tsx"), "utf8")
    expect(agents.includes("displayPermissionRulesLastMatch") || agents.includes("toPermissionRuleset")).toBe(true)
    expect(agents.includes("SavedPermissionsSection")).toBe(true)
    expect(agents.includes("summaryPermissionNames.map")).toBe(false)
    expect(saved.includes("listPermissionSaved")).toBe(true)
    expect(saved.includes("deletePermissionSaved")).toBe(true)
    expect(saved.includes("settings.permissions.saved.title")).toBe(true)
  })

  test("pending forms render on the current session; reply/cancel are wired", () => {
    const chat = readFileSync(join(here, "../components/chat/ChatContainer.tsx"), "utf8")
    const formCard = readFileSync(join(here, "../components/chat/FormCard.tsx"), "utf8")
    expect(chat.includes("FormCard")).toBe(true)
    expect(chat.includes("useSessionFormStore") || chat.includes("sessionForms")).toBe(true)
    expect(formCard.includes("postSessionFormReply")).toBe(true)
    expect(formCard.includes("postSessionFormCancel")).toBe(true)
    expect(formCard.includes("chat.form.reply")).toBe(true)
    expect(formCard.includes("chat.form.cancel")).toBe(true)
  })

  test("retry+action uses locale quota/account copy, not toast.error", () => {
    const chat = readFileSync(join(here, "../components/chat/ChatContainer.tsx"), "utf8")
    const retry = readFileSync(join(here, "session-retry-action.ts"), "utf8")
    const en = readFileSync(join(here, "../lib/i18n/messages/en.ts"), "utf8")
    const zhCN = readFileSync(join(here, "../lib/i18n/messages/zh-CN.ts"), "utf8")
    const enSettings = readFileSync(join(here, "../lib/i18n/messages/en.settings.ts"), "utf8")
    const zhCNSettings = readFileSync(join(here, "../lib/i18n/messages/zh-CN.settings.ts"), "utf8")
    expect(chat.includes("isSessionRetryAction") || chat.includes("resolveRetryActionCopy")).toBe(true)
    expect(chat.includes("toast.error(status.message)")).toBe(false)
    expect(retry.includes("shouldToastSessionRetryAsError")).toBe(true)
    expect(en.includes("'chat.retry.action.quota'")).toBe(true)
    expect(en.includes("'chat.form.reply'")).toBe(true)
    expect(zhCN.includes("'chat.retry.action.quota': '已达用量上限'")).toBe(true)
    expect(zhCN.includes("'chat.form.reply': '提交'")).toBe(true)
    expect(enSettings.includes("'settings.permissions.saved.title'")).toBe(true)
    expect(zhCNSettings.includes("'settings.permissions.saved.title': '已保存的项目权限'")).toBe(true)
  })

  test("does not install the v2 client SDK", () => {
    const files = [
      readFileSync(join(here, "permission-saved-api.ts"), "utf8"),
      readFileSync(join(here, "session-permission-api.ts"), "utf8"),
      readFileSync(join(here, "session-form-api.ts"), "utf8"),
    ]
    const actions = readFileSync(join(here, "session-actions.ts"), "utf8")
    expect(actions.includes("postSessionPermissionReply")).toBe(true)
    for (const source of files) {
      expect(/from ["']@opencode-ai\/client["']/.test(source)).toBe(false)
    }
  })
})
