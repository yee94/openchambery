import { describe, expect, test } from "bun:test"
import {
  isAtOrAfterRevert,
  messagesVisibleWithRevert,
  resolveRevertRedoTarget,
  resolveRevertUndoTarget,
} from "./conversation-order"

const row = (id: string, role: "user" | "assistant") => ({ id, role })

// Conversation: older high-id user, assistant, later low-id user, assistant.
const conversation = [
  row("msg_9", "user"),
  row("msg_1", "assistant"),
  row("msg_2", "user"),
  row("msg_3", "assistant"),
]

describe("conversation-order revert helpers", () => {
  test("messagesVisibleWithRevert hides the target and everything after it", () => {
    expect(messagesVisibleWithRevert(conversation, "msg_2").map((message) => message.id)).toEqual([
      "msg_9",
      "msg_1",
    ])
  })

  test("messagesVisibleWithRevert does not hide an earlier high-id row", () => {
    // Id-sort would treat msg_9 as after msg_2 and hide it.
    expect(messagesVisibleWithRevert(conversation, "msg_2").some((message) => message.id === "msg_9")).toBe(true)
  })

  test("messagesVisibleWithRevert shows everything when the target is missing", () => {
    expect(messagesVisibleWithRevert(conversation, "missing").map((message) => message.id)).toEqual(
      conversation.map((message) => message.id),
    )
  })

  test("isAtOrAfterRevert is conversation-position, not id order", () => {
    expect(isAtOrAfterRevert(conversation, "msg_2", "msg_2")).toBe(true)
    expect(isAtOrAfterRevert(conversation, "msg_3", "msg_2")).toBe(true)
    expect(isAtOrAfterRevert(conversation, "msg_9", "msg_2")).toBe(false)
    expect(isAtOrAfterRevert(conversation, "msg_1", "msg_2")).toBe(false)
  })

  test("undo without a marker targets the latest user turn", () => {
    expect(resolveRevertUndoTarget(conversation, undefined)?.id).toBe("msg_2")
  })

  test("undo with a marker targets the previous user turn", () => {
    expect(resolveRevertUndoTarget(conversation, "msg_2")?.id).toBe("msg_9")
  })

  test("undo does not pick a later low-id user via id comparison", () => {
    // Id-sort undo from msg_9 would find msg_2 (msg_2 < msg_9) as "previous".
    expect(resolveRevertUndoTarget(conversation, "msg_9")).toBe(undefined)
  })

  test("redo targets the next user turn after the marker", () => {
    expect(resolveRevertRedoTarget(conversation, "msg_9")?.id).toBe("msg_2")
  })

  test("redo does not pick an earlier high-id user via id comparison", () => {
    // Id-sort redo from msg_2 would find msg_9 (msg_9 > msg_2).
    expect(resolveRevertRedoTarget(conversation, "msg_2")).toBe(undefined)
  })
})
