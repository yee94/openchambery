import { describe, expect, test } from "bun:test"
import { parseLegacyDraftComposerDocument } from "./input-draft-composer-parser"

describe("legacy draft composer parser", () => {
  test("imports plain text, v1 paste occurrences, and complete v2 documents", () => {
    expect(parseLegacyDraftComposerDocument("plain")).toEqual({ text: "plain", references: [] })
    const v1 = JSON.stringify({ type: "yuri-pasted-text-draft", version: 1, text: "[P] [P]", references: [{ id: "p", token: "[P]", text: "payload", characterCount: 7, index: 1 }] })
    expect(parseLegacyDraftComposerDocument(v1).references.map((reference) => [reference.id, reference.start, reference.end])).toEqual([["p:0", 0, 3], ["p:1", 4, 7]])
    expect(parseLegacyDraftComposerDocument(v1.replace('yuri-pasted-text-draft', 'openchamber-pasted-text-draft'))).toEqual(parseLegacyDraftComposerDocument(v1))
    const v2 = JSON.stringify({ type: "yuri-composer-reference-draft", version: 2, text: "@Session", references: [{ id: "s", kind: "session", sessionId: "ses_1", start: 0, end: 8, display: "@Session" }] })
    expect(parseLegacyDraftComposerDocument(v2).references).toHaveLength(1)
    expect(parseLegacyDraftComposerDocument(v2.replace('yuri-composer-reference-draft', 'openchamber-composer-reference-draft'))).toEqual(parseLegacyDraftComposerDocument(v2))
  })

  test("keeps recoverable visible text when a composer envelope is damaged", () => {
    const damaged = JSON.stringify({ type: "yuri-composer-reference-draft", version: 2, text: "visible", references: [{ id: "bad", kind: "session", sessionId: "bad id", start: 0, end: 7, display: "visible" }] })
    expect(parseLegacyDraftComposerDocument(damaged)).toEqual({ text: "visible", references: [] })
  })
})
