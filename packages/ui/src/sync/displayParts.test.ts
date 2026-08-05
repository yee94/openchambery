import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"

import { allowsAuthoritativeShrink, mergePartsForDisplay } from "./displayParts"

const info = (input: { role?: string; finish?: string; completed?: number } = {}): Message => ({
  id: "msg_1",
  sessionID: "ses_1",
  role: input.role ?? "assistant",
  time: { created: 1, ...(input.completed ? { completed: input.completed } : {}) },
  ...(input.finish ? { finish: input.finish } : {}),
}) as Message

const tool = (id: string, status = "completed"): Part => ({
  id,
  type: "tool",
  tool: "bash",
  state: { status, time: { start: 1, ...(status === "completed" ? { end: 2 } : {}) } },
}) as Part

const text = (id: string, value: string): Part => ({ id, type: "text", text: value }) as Part

describe("allowsAuthoritativeShrink", () => {
  test("open assistant may not shrink", () => {
    expect(allowsAuthoritativeShrink(info())).toBe(false)
  })

  test("settled assistant follows the authoritative snapshot", () => {
    expect(allowsAuthoritativeShrink(info({ finish: "stop" }))).toBe(true)
    expect(allowsAuthoritativeShrink(info({ completed: 5 }))).toBe(true)
  })

  test("user rows always follow the store so optimistic replacement is not doubled", () => {
    expect(allowsAuthoritativeShrink(info({ role: "user" }))).toBe(true)
  })
})

describe("mergePartsForDisplay", () => {
  test("an empty frame never clears an open assistant", () => {
    const previous = [tool("t1"), tool("t2")]
    expect(mergePartsForDisplay(previous, [], info())).toBe(previous)
  })

  test("a lagging page that omits a tool keeps it, in position", () => {
    const previous = [text("p1", "a"), tool("t1"), tool("t2"), text("p2", "b")]
    const incoming = [text("p1", "a"), tool("t1"), text("p2", "b")]
    const merged = mergePartsForDisplay(previous, incoming, info())
    expect(merged.map((part) => part.id)).toEqual(["p1", "t1", "t2", "p2"])
  })

  test("an unchanged lagging frame reuses the previous array reference", () => {
    // The store hands back the same part objects when nothing changed, so the
    // merge must resolve to the same array or every commit would rebuild the
    // snapshot and the turn projection behind it.
    const kept = tool("t1")
    const previous = [kept, tool("t2")]
    expect(mergePartsForDisplay(previous, [kept], info())).toBe(previous)
  })

  test("a fresher copy of a held frame's part is adopted", () => {
    const previous = [tool("t1", "running"), tool("t2")]
    const fresher = tool("t1")
    const merged = mergePartsForDisplay(previous, [fresher], info())
    expect(merged[0]).toBe(fresher)
    expect(merged.map((part) => part.id)).toEqual(["t1", "t2"])
  })

  test("a richer frame wins and its fresher part content is used", () => {
    const previous = [tool("t1", "running")]
    const incoming = [tool("t1"), tool("t2")]
    const merged = mergePartsForDisplay(previous, incoming, info())
    expect(merged).toBe(incoming)
  })

  test("held rows keep leading position when the frame drops the head", () => {
    const previous = [tool("t1"), tool("t2")]
    const merged = mergePartsForDisplay(previous, [tool("t2")], info())
    expect(merged.map((part) => part.id)).toEqual(["t1", "t2"])
  })

  test("a settled assistant releases the hold on the next frame", () => {
    const previous = [tool("t1"), tool("t2")]
    const incoming = [tool("t1")]
    expect(mergePartsForDisplay(previous, incoming, info())).not.toBe(incoming)
    expect(mergePartsForDisplay(previous, incoming, info({ finish: "stop" }))).toBe(incoming)
  })

  test("repeated identical frames never grow the result", () => {
    // Regression guard for the render-layer hold this replaced: it fed its own
    // output back in as the baseline, so a held row could accumulate.
    let current: Part[] = [tool("t1"), tool("t2")]
    for (let round = 0; round < 5; round += 1) {
      current = mergePartsForDisplay(current, [tool("t1")], info())
    }
    expect(current.map((part) => part.id)).toEqual(["t1", "t2"])
  })
})
