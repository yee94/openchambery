import { describe, expect, test } from "bun:test"
import { cloneDraftRecord, DRAFT_COMPOSER_REFERENCE_LIMITS, draftAttachmentRefID, draftKeyString, draftRootAttachmentOccurrenceRefID, draftSyntheticPartAttachmentOccurrenceRefID, isDraftRecordPersistable, newSessionDraftKey, parseDraftMentions, parseDraftRecord, sessionDraftKey, type DraftRecord } from "./input-draft-types"

const record = (): DraftRecord => ({
  version: 1,
  key: { transportIdentity: "runtime-a", owner: { kind: "session", ownerID: "same" } },
  revision: 1,
  text: "@file-a@agent-a",
  attachments: [{ attachmentID: "root-a", attachmentRefID: draftRootAttachmentOccurrenceRefID("root-a"), filename: "a.txt", mimeType: "text/plain", size: 1, locator: { kind: "blob", blobID: "blob-a" }, source: "local" }],
  syntheticParts: [{ partID: "part-a", text: "part", attachments: [{ attachmentID: "part-a", attachmentRefID: draftSyntheticPartAttachmentOccurrenceRefID("part-a", "part-a"), filename: "a.txt", mimeType: "text/plain", size: 1, locator: { kind: "url", url: "https://example.test/a" }, source: "server", serverPath: "/server/a" }] }],
  mentions: [{ kind: "file", value: "file-a", path: "/a", label: "a", range: { start: 0, end: 7 } }, { kind: "agent", value: "agent-a", path: "agent/a", label: "Agent A", range: { start: 7, end: 15 } }],
})

describe("input draft types", () => {
  test("accepts directory mention kind", () => {
    const text = "@opencode"
    const mentions = [{ kind: "directory" as const, value: "opencode", path: "opencode", label: "opencode", range: { start: 0, end: 9 } }]
    expect(parseDraftMentions(text, mentions)).toEqual(mentions)
  })

  test("strictly parses authored mention ranges", () => {
    const text = "@README @agent"
    const mentions = [{ kind: "file", value: "README", path: "README", label: "README", range: { start: 0, end: 7 } }, { kind: "agent", value: "agent", path: "agent", label: "agent", range: { start: 8, end: 14 } }]
    expect(parseDraftMentions(text, mentions)).toEqual(mentions)
    expect(parseDraftMentions(text, [{ ...mentions[0]!, range: { start: 0, end: 6 } }])).toBe(undefined)
    expect(parseDraftMentions(text, [mentions[0], { ...mentions[1]!, range: { start: 6, end: 14 } }])).toBe(undefined)
    expect(parseDraftMentions("@😀", [{ kind: "file", value: "😀", path: "😀", label: "😀", range: { start: 0, end: 3 } }])).toEqual([{ kind: "file", value: "😀", path: "😀", label: "😀", range: { start: 0, end: 3 } }])
    expect(parseDraftMentions("@😀", [{ kind: "file", value: "😀", path: "😀", label: "😀", range: { start: 0, end: 2 } }])).toBe(undefined)
    expect(parseDraftMentions(text, Array.from({ length: 1001 }, () => mentions[0]))).toBe(undefined)
  })
  test("serializes transport-scoped attachment references and distinguishes occurrences", () => {
    const reference = { transportIdentity: "runtime-a", owner: { kind: "session", ownerID: "same" } as const, attachmentOccurrenceRefID: draftRootAttachmentOccurrenceRefID("attachment-a") }
    expect(draftKeyString(reference)).toBe('["runtime-a","session","same"]')
    expect(draftAttachmentRefID(reference)).toBe('["runtime-a","session","same","[\\"root\\",\\"attachment-a\\"]"]')
    expect(draftAttachmentRefID({ ...reference, transportIdentity: "runtime-b" })).not.toBe(draftAttachmentRefID(reference))
    expect(draftSyntheticPartAttachmentOccurrenceRefID("part-a", "attachment-a")).not.toBe(draftRootAttachmentOccurrenceRefID("attachment-a"))
  })

  test("builds stable session and new-session keys from transport identity", () => {
    expect(sessionDraftKey({ transportIdentity: "runtime-a" }, "session-a")).toEqual({ transportIdentity: "runtime-a", owner: { kind: "session", ownerID: "session-a" } })
    expect(newSessionDraftKey({ transportIdentity: "runtime-a" }, "draft-a")).toEqual({ transportIdentity: "runtime-a", owner: { kind: "draft", ownerID: "draft-a" } })
    expect(() => sessionDraftKey({ transportIdentity: "" }, "session-a")).toThrow("transportIdentity")
    expect(() => newSessionDraftKey({ transportIdentity: "runtime-a" }, "")).toThrow("draftID")
  })

  test("parses and clones the complete frozen DTO", () => {
    const draft = record()
    const parsed = parseDraftRecord(draft)
    expect(parsed).toEqual(draft)
    const cloned = cloneDraftRecord(draft)
    expect(cloned).toEqual(draft)
    expect(cloned).not.toBe(draft)
    expect(cloned?.attachments[0]).not.toBe(draft.attachments[0])
    expect(isDraftRecordPersistable(draft)).toBe(true)
  })

  test("rejects unknown fields at every DTO depth", () => {
    const topLevel = { ...record(), extra: true }
    const synthetic = record()
    synthetic.syntheticParts[0] = { ...synthetic.syntheticParts[0]!, extra: true } as never
    const mention = record()
    mention.mentions[0] = { ...mention.mentions[0]!, extra: true } as never
    const nested = record()
    nested.attachments[0] = { ...nested.attachments[0]!, locator: { ...nested.attachments[0]!.locator, extra: true } } as never
    expect(parseDraftRecord(topLevel)).toBe(undefined)
    expect(parseDraftRecord(synthetic)).toBe(undefined)
    expect(parseDraftRecord(mention)).toBe(undefined)
    expect(parseDraftRecord(nested)).toBe(undefined)
  })

  test("rejects unsafe values and malformed DTO fields", () => {
    const cyclic = record() as DraftRecord & { cycle?: unknown }
    cyclic.cycle = cyclic
    expect(parseDraftRecord(cyclic)).toBe(undefined)
    expect(parseDraftRecord({ ...record(), revision: -1 })).toBe(undefined)
    expect(parseDraftRecord({ ...record(), revision: 0 })).toBe(undefined)
    expect(parseDraftRecord({ ...record(), attachments: [{ ...record().attachments[0]!, locator: { kind: "url", url: "blob:unsafe" } }] })).toBe(undefined)
    expect(parseDraftRecord({ ...record(), attachments: [{ ...record().attachments[0]!, locator: { kind: "url", url: "data:text/plain,unsafe" } }] })).toBe(undefined)
    expect(parseDraftRecord({ ...record(), mentions: [{ ...record().mentions[0]!, range: { start: 2, end: 2 } }] })).toBe(undefined)
    expect(parseDraftRecord({ ...record(), mentions: [{ ...record().mentions[0]!, range: { start: 0, end: 6 } }] })).toBe(undefined)
    expect(parseDraftRecord({ ...record(), attachments: [{ ...record().attachments[0]!, file: new File(["x"], "a.txt") }] })).toBe(undefined)
  })

  test("accepts durable file URLs and rejects queue and send draft keys", () => {
    const file = record()
    file.attachments[0] = { ...file.attachments[0]!, locator: { kind: "url", url: "file:///tmp/a.txt" } }
    expect(parseDraftRecord(file)).toEqual(file)
    for (const kind of ["queue", "send"]) {
      expect(parseDraftRecord({ ...record(), key: { transportIdentity: "runtime-a", owner: { kind, ownerID: "owner" } } })).toBe(undefined)
    }
  })

  test("validates occurrence structure and record-wide attachment and part identity", () => {
    const wrongRoot = record()
    wrongRoot.attachments[0] = { ...wrongRoot.attachments[0]!, attachmentRefID: draftSyntheticPartAttachmentOccurrenceRefID("part-a", "root-a") }
    const wrongPart = record()
    wrongPart.syntheticParts[0]!.attachments[0] = { ...wrongPart.syntheticParts[0]!.attachments[0]!, attachmentRefID: draftSyntheticPartAttachmentOccurrenceRefID("other-part", "part-a") }
    const duplicateRef = record()
    duplicateRef.syntheticParts[0]!.attachments[0] = { ...duplicateRef.syntheticParts[0]!.attachments[0]!, attachmentRefID: duplicateRef.attachments[0]!.attachmentRefID }
    const duplicatePart = record()
    duplicatePart.syntheticParts.push({ ...duplicatePart.syntheticParts[0]! })
    expect(parseDraftRecord(wrongRoot)).toBe(undefined)
    expect(parseDraftRecord(wrongPart)).toBe(undefined)
    expect(parseDraftRecord(duplicateRef)).toBe(undefined)
    expect(parseDraftRecord(duplicatePart)).toBe(undefined)
  })

  test("enforces source-specific attachment fields while allowing empty MIME types", () => {
    const emptyMime = record()
    emptyMime.attachments[0] = { ...emptyMime.attachments[0]!, mimeType: "" }
    const vscode = record()
    vscode.attachments[0] = { ...vscode.attachments[0]!, source: "vscode", vscodePath: "/vscode/a", vscodeSource: "selection" }
    const invalidVscodeSource = record()
    invalidVscodeSource.attachments[0] = { ...invalidVscodeSource.attachments[0]!, source: "vscode", vscodePath: "/vscode/a", vscodeSource: "workspace" as never }
    const missingVscodeFields = record()
    missingVscodeFields.attachments[0] = { ...missingVscodeFields.attachments[0]!, source: "vscode" }
    const missingServerPath = record()
    missingServerPath.syntheticParts[0]!.attachments[0] = { ...missingServerPath.syntheticParts[0]!.attachments[0]!, serverPath: undefined }
    expect(parseDraftRecord(emptyMime)).toEqual(emptyMime)
    expect(parseDraftRecord(vscode)).toEqual(vscode)
    expect(parseDraftRecord(invalidVscodeSource)).toBe(undefined)
    expect(parseDraftRecord(missingVscodeFields)).toBe(undefined)
    expect(parseDraftRecord(missingServerPath)).toBe(undefined)
  })

  test("keeps old records readable and round-trips durable composer sidecars", () => {
    const legacy = record()
    const document = record()
    document.text = "@Session [Paste] /review-pr /run"
    document.mentions = []
    document.composerReferences = [
      { id: "session-1", kind: "session", sessionId: "ses_1", start: 0, end: 8, display: "@Session" },
      { id: "paste-1", kind: "paste", text: "😀x", characterCount: 2, index: 1, start: 9, end: 16, display: "[Paste]" },
      { id: "skill-1", kind: "skill", skillName: "review-pr", start: 17, end: 27, display: "/review-pr" },
      { id: "command-1", kind: "command", commandName: "run", reference: "task-42", start: 28, end: 32, display: "/run" },
    ]
    expect(parseDraftRecord(legacy)?.composerReferences).toBe(undefined)
    expect(cloneDraftRecord(document)).toEqual(document)
  })

  test("rejects invalid durable composer sidecars as a complete record", () => {
    const document = record()
    document.text = "@one @two"
    document.composerReferences = [
      { id: "same", kind: "session", sessionId: "ses_1", start: 0, end: 4, display: "@one" },
      { id: "same", kind: "session", sessionId: "ses_2", start: 3, end: 8, display: "e @tw" },
    ]
    expect(parseDraftRecord(document)).toBe(undefined)
    document.composerReferences = [{ id: "bad-session", kind: "session", sessionId: "bad id", start: 0, end: 4, display: "@one" }]
    expect(parseDraftRecord(document)).toBe(undefined)
    document.text = "/skill"
    document.composerReferences = [{ id: "bad-skill", kind: "skill", skillName: "bad skill", start: 0, end: 6, display: "/skill" }]
    expect(parseDraftRecord(document)).toBe(undefined)
    document.composerReferences = [{ id: "bad-command", kind: "command", commandName: "", reference: "ref", start: 0, end: 6, display: "/skill" }]
    expect(parseDraftRecord(document)).toBe(undefined)
    document.text = "[a][b][c]"
    document.composerReferences = Array.from({ length: 3 }, (_, index) => ({ id: `paste-${index}`, kind: "paste" as const, text: "x".repeat(80_000), characterCount: 80_000, index: index + 1, start: index * 3, end: index * 3 + 3, display: `[${String.fromCharCode(97 + index)}]` }))
    expect(parseDraftRecord(document)).toBe(undefined)
    expect(DRAFT_COMPOSER_REFERENCE_LIMITS.totalPastePayloadLength).toBeGreaterThan(0)
  })
})
