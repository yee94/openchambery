import { describe, expect, test } from "bun:test"
import { isMobileShareHandoffMarkerPart } from "@/apps/mobileShareDraftHandoff"
import { createInputStore } from "@/sync/input-store"
import { surfaceDraftKey } from "@/sync/input-draft-types"
import type { AttachedFile } from "@/stores/types/sessionTypes"
import {
  mapSyntheticPartsWithViews,
  mergeSyntheticPartsByPartID,
  projectRootAttachmentViews,
} from "./assistantDraftAttachments"

const view = (id: string, filename: string): AttachedFile => ({
  id,
  file: new File([], filename),
  dataUrl: `data:text/plain,${filename}`,
  mimeType: "text/plain",
  filename,
  size: 1,
  source: "local",
})

describe("assistantDraftAttachments helpers", () => {
  test("projectRootAttachmentViews follows record.attachments order only", () => {
    const rootA = view("a", "a.txt")
    const rootB = view("b", "b.txt")
    const syntheticView = view("s", "s.txt")
    const views = {
      '["root","a"]': rootA,
      '["root","b"]': rootB,
      '["part","p1","s"]': syntheticView,
    }
    const record = {
      attachments: [
        { attachmentID: "b", attachmentRefID: '["root","b"]', filename: "b.txt", mimeType: "text/plain", size: 1, locator: { kind: "url" as const, url: "x" }, source: "local" as const },
        { attachmentID: "a", attachmentRefID: '["root","a"]', filename: "a.txt", mimeType: "text/plain", size: 1, locator: { kind: "url" as const, url: "x" }, source: "local" as const },
      ],
    }
    expect(projectRootAttachmentViews(record, views).map((item) => item.filename)).toEqual(["b.txt", "a.txt"])
    // Synthetic views never appear in root projection.
    expect(projectRootAttachmentViews(record, views).some((item) => item.id === "s")).toBe(false)
  })

  test("mapSyntheticPartsWithViews resolves part attachments without root", () => {
    const partView = view("p-att", "part.txt")
    const views = {
      '["part","send","p-att"]': partView,
    }
    const mapped = mapSyntheticPartsWithViews(
      [
        {
          partID: "send",
          text: "ctx",
          attachments: [
            {
              attachmentID: "p-att",
              attachmentRefID: '["part","send","p-att"]',
              filename: "part.txt",
              mimeType: "text/plain",
              size: 1,
              locator: { kind: "url", url: "x" },
              source: "local",
            },
          ],
        },
      ],
      views,
    )
    expect(mapped).toEqual([
      { partID: "send", text: "ctx", attachments: [partView] },
    ])
  })

  test("mergeSyntheticPartsByPartID replaces by id and retains concurrent parts", () => {
    const empty = [] as import("@/sync/input-draft-types").DraftAttachmentMetadata[]
    const marker = {
      partID: "mobile-share-handoff:share",
      text: "",
      attachments: empty,
      synthetic: true as const,
    }
    const concurrent = { partID: "concurrent", text: "new", attachments: empty }
    const current = [
      marker,
      { partID: "send", text: "old", attachments: empty },
      concurrent,
    ]
    const restored = [
      { partID: "send", text: "restored", attachments: empty },
      { partID: "extra", text: "extra", attachments: empty },
    ]
    const merged = mergeSyntheticPartsByPartID(current, restored)
    expect(merged.map((part) => part.partID)).toEqual([
      "mobile-share-handoff:share",
      "send",
      "concurrent",
      "extra",
    ])
    expect(merged.find((part) => part.partID === "send")?.text).toBe("restored")
    expect(isMobileShareHandoffMarkerPart(merged[0]!)).toBe(true)
  })
})

describe("Assistant draft synthetic consume/restore integration", () => {
  test("consume retain keeps handoff marker; restore merge keeps marker after failed-send restore", () => {
    const store = createInputStore({ persistenceEnabled: false })
    const draftKey = surfaceDraftKey({ transportIdentity: "runtime" }, "assistant:a1")
    store.getState().ensureDraft(draftKey)
    store.getState().setDraftSyntheticParts(draftKey, [
      { partID: "mobile-share-handoff:share", text: "", attachments: [], synthetic: true },
      { partID: "send", text: "context", attachments: [] },
    ])
    const consumed = store.getState().consumeDraftSyntheticParts(draftKey, isMobileShareHandoffMarkerPart)
    expect(consumed).toEqual([{ partID: "send", text: "context", attachments: [] }])
    expect(store.getState().getDraft(draftKey)?.syntheticParts).toEqual([
      { partID: "mobile-share-handoff:share", text: "", attachments: [], synthetic: true },
    ])

    // Mirror AssistantView restoreSyntheticParts merge contract after send failure.
    const current = store.getState().getDraft(draftKey)?.syntheticParts ?? []
    const restored = [{ partID: "send", text: "context", attachments: [] }]
    const merged = mergeSyntheticPartsByPartID(current, restored)
    store.getState().setDraftSyntheticParts(draftKey, merged)
    expect(store.getState().getDraft(draftKey)?.syntheticParts?.map((part) => part.partID)).toEqual([
      "mobile-share-handoff:share",
      "send",
    ])
  })
})
