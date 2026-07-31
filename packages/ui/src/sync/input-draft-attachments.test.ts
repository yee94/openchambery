import { describe, expect, test } from "bun:test"
import { createInputDraftBlobStore, MemoryInputDraftBlobDriver } from "./input-draft-blob-store"
import { createInputDraftMetadataStorageSink } from "./input-draft-metadata-store"
import { draftKeyString, type DraftKey } from "./input-draft-types"
import { createInputStore } from "./input-store"

class TestFileReader {
  result: string | ArrayBuffer | null = null
  onload: ((event: ProgressEvent<FileReader>) => unknown) | null = null
  onerror: ((event: ProgressEvent<FileReader>) => unknown) | null = null
  onabort: ((event: ProgressEvent<FileReader>) => unknown) | null = null
  readAsDataURL() { this.result = "data:text/plain;base64,eA=="; queueMicrotask(() => this.onload?.({} as ProgressEvent<FileReader>)) }
}

globalThis.FileReader = TestFileReader as unknown as typeof FileReader

class MemoryStorage {
  values = new Map<string, string>()
  get length() { return this.values.size }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}

const key = (ownerID = "session", transportIdentity = "runtime"): DraftKey => ({ transportIdentity, owner: { kind: "session", ownerID } })
const createStore = async () => {
  const blobs = createInputDraftBlobStore(new MemoryInputDraftBlobDriver())
  const store = createInputStore({ sink: createInputDraftMetadataStorageSink(new MemoryStorage() as unknown as Storage), blobStore: blobs, createID: (() => { let id = 0; return () => `id-${++id}` })(), runtimeCapture: () => ({ transportIdentity: "runtime", generation: 1 }) })
  await store.getState().hydrateDraftMetadata("runtime")
  return { store, blobs }
}

describe("input store durable attachments", () => {
  test("persists local root and synthetic occurrences through the store coordinator", async () => {
    const { store, blobs } = await createStore()
    const root = await store.getState().addDraftLocalAttachment(key(), new File(["root"], "root.txt", { type: "text/plain" }))
    store.getState().setDraftSyntheticParts(key(), [{ partID: "part", text: "context", attachments: [] }])
    const synthetic = await store.getState().addDraftLocalAttachment(key(), new File(["synthetic"], "synthetic.txt", { type: "text/plain" }), { partID: "part" })
    await store.getState().flushDraftPersistence()
    if (!root || !synthetic || root.locator.kind !== "blob") throw new Error("attachments were not created")
    expect((await blobs.read(root.locator.blobID)).ok).toBe(true)
    expect(store.getState().getDraft(key())?.syntheticParts[0]?.attachments[0]?.attachmentRefID).toBe(synthetic?.attachmentRefID)
  })

  test("removes and replaces occurrences while retaining editable state", async () => {
    const { store } = await createStore()
    const first = await store.getState().addDraftLocalAttachment(key(), new File(["one"], "one.txt", { type: "text/plain" }))
    await store.getState().flushDraftPersistence()
    expect(await store.getState().removeDraftAttachment(key(), first!.attachmentRefID)).toBe(true)
    const second = await store.getState().addDraftLocalAttachment(key(), new File(["two"], "two.txt", { type: "text/plain" }))
    const replaced = await store.getState().replaceDraftAttachment(key(), second!.attachmentRefID, new File(["three"], "three.txt", { type: "text/plain" }))
    expect(replaced?.filename).toBe("three.txt")
    expect(store.getState().getDraftAttachmentViews(key()).map((item) => item.filename)).toEqual(["three.txt"])
  })

  test("removeDraftAttachment clears inline image citations in the same revision", async () => {
    const { store } = await createStore()
    const image = await store.getState().addDraftLocalAttachment(key(), new File(["img"], "image-1.png", { type: "image/png" }))
    store.getState().setDraftComposerState(key(), {
      document: { text: "look [\u2003image-1.png] please", references: [] },
      mentions: [],
    })
    const before = store.getState().getDraft(key())!.revision
    expect(await store.getState().removeDraftAttachment(key(), image!.attachmentRefID)).toBe(true)
    const draft = store.getState().getDraft(key())!
    expect(draft.text).toBe("look please")
    expect(draft.attachments).toEqual([])
    expect(draft.revision).toBe(before + 1)
  })

  test("removeDraftAttachment leaves ordinary file draft text alone", async () => {
    const { store } = await createStore()
    const file = await store.getState().addDraftLocalAttachment(key(), new File(["note"], "note.txt", { type: "text/plain" }))
    store.getState().setDraftText(key(), "keep this body")
    expect(await store.getState().removeDraftAttachment(key(), file!.attachmentRefID)).toBe(true)
    expect(store.getState().getDraft(key())!.text).toBe("keep this body")
  })

  test("moves and deletes blob-backed drafts through one coordinator transaction", async () => {
    const { store, blobs } = await createStore()
    const source = key("source")
    const destination = key("destination")
    const attached = await store.getState().addDraftLocalAttachment(source, new File(["move"], "move.txt", { type: "text/plain" }))
    await store.getState().flushDraftPersistence()
    const moved = await store.getState().moveDraftWithAttachments(source, destination)
    expect(moved?.key).toEqual(destination)
    expect(store.getState().deleteDraft(destination)).toBe(true)
    await store.getState().flushDraftPersistence()
    if (!attached || attached.locator.kind !== "blob") throw new Error("attachment was not created")
    expect((await blobs.read(attached.locator.blobID)).ok).toBe(false)
  })

  test("keeps disabled drafts memory-only and marks missing hydrated blobs degraded", async () => {
    const { store } = await createStore()
    await store.getState().setDraftPersistenceEnabled(false)
    const attached = await store.getState().addDraftLocalAttachment(key(), new File(["memory"], "memory.txt", { type: "text/plain" }))
    expect(attached).toBeDefined()
    expect(store.getState().draftPersistence[draftKeyString(key())]).toBe(undefined)
    await store.getState().setDraftPersistenceEnabled(true)
    await store.getState().hydrateDraftAttachments(key())
    expect(store.getState().draftHydration[draftKeyString(key())]).toBe("ready")
  })

  test("flushes a local attachment without timer synchronization", async () => {
    const { store, blobs } = await createStore()
    const attachment = await store.getState().addDraftLocalAttachment(key(), new File(["flush"], "flush.txt"))
    await store.getState().flushDraftPersistence()
    expect(attachment?.locator.kind).toBe("blob")
    if (attachment?.locator.kind === "blob") expect((await blobs.read(attachment.locator.blobID)).ok).toBe(true)
  })

  test("orders root attachments before synthetic attachments", async () => {
    const { store } = await createStore()
    await store.getState().addDraftLocalAttachment(key(), new File(["root"], "root.txt"))
    store.getState().setDraftSyntheticParts(key(), [{ partID: "part", text: "part", attachments: [] }])
    await store.getState().addDraftLocalAttachment(key(), new File(["part"], "part.txt"), { partID: "part" })
    expect(store.getState().getDraftAttachmentViews(key()).map((file) => file.filename)).toEqual(["root.txt", "part.txt"])
  })

  test("rejects durable attachment for an absent synthetic part", async () => {
    const { store } = await createStore()
    expect(store.getState().addDraftDurableAttachment(key(), { filename: "url.txt", mimeType: "text/plain", size: 1, source: "server", serverPath: "/url.txt", url: "https://example.test/url.txt", partID: "absent" })).toBe(undefined)
  })

  test("moves URL-only drafts across an older destination tombstone", async () => {
    const { store } = await createStore()
    const source = key("source-url")
    const destination = key("destination-url")
    store.getState().addDraftDurableAttachment(source, { filename: "url.txt", mimeType: "text/plain", size: 1, source: "server", serverPath: "/url.txt", url: "https://example.test/url.txt" })
    expect(store.getState().moveDraft(source, destination)?.key).toEqual(destination)
  })

  test("delete clears ephemeral attachment state", async () => {
    const { store } = await createStore()
    await store.getState().addDraftLocalAttachment(key(), new File(["delete"], "delete.txt"))
    const id = draftKeyString(key())
    store.setState((state) => ({
      draftHydration: { ...state.draftHydration, [id]: "degraded" },
      draftPersistence: { ...state.draftPersistence, [id]: { status: "error", revision: 1, errorCode: "quota" } },
      draftMissingAttachmentRefIDs: { ...state.draftMissingAttachmentRefIDs, [id]: ["missing"] },
      draftAttachmentPersistence: { ...state.draftAttachmentPersistence, [id]: { status: "error", revision: 1, errorCode: "transaction-failed" } },
    }))
    expect(store.getState().deleteDraft(key())).toBe(true)
    expect(store.getState().draftHydration[id]).toBe(undefined)
    expect(store.getState().draftPersistence[id]).toBe(undefined)
    expect(store.getState().draftAttachmentViews[id]).toBe(undefined)
    expect(store.getState().draftMissingAttachmentRefIDs[id]).toBe(undefined)
    expect(store.getState().draftAttachmentPersistence[id]).toBe(undefined)
  })

  test("moves all temporary attachment state to the destination", async () => {
    const { store } = await createStore()
    const source = key("source")
    const destination = key("destination")
    store.getState().addDraftDurableAttachment(source, { filename: "url.txt", mimeType: "text/plain", size: 1, source: "server", serverPath: "/url", url: "https://example.test/url" })
    const sourceID = draftKeyString(source); const destinationID = draftKeyString(destination)
    store.setState((state) => ({
      draftHydration: { ...state.draftHydration, [sourceID]: "degraded", [destinationID]: "error" },
      draftPersistence: { ...state.draftPersistence, [sourceID]: { status: "error", revision: 2, errorCode: "quota" }, [destinationID]: { status: "saved", revision: 1 } },
      draftAttachmentViews: { ...state.draftAttachmentViews, [sourceID]: { source: {} as never } as Record<string, never>, [destinationID]: { destination: {} as never } as Record<string, never> },
      draftMissingAttachmentRefIDs: { ...state.draftMissingAttachmentRefIDs, [sourceID]: ["missing"], [destinationID]: ["old"] },
      draftAttachmentPersistence: { ...state.draftAttachmentPersistence, [sourceID]: { status: "error", revision: 2, errorCode: "transaction-failed" }, [destinationID]: { status: "saved", revision: 1 } },
    }))
    expect(store.getState().moveDraft(source, destination)?.key).toEqual(destination)
    expect(store.getState().draftHydration[sourceID]).toBe(undefined)
    expect(store.getState().draftPersistence[sourceID]).toBe(undefined)
    expect(store.getState().draftAttachmentViews[sourceID]).toBe(undefined)
    expect(store.getState().draftMissingAttachmentRefIDs[sourceID]).toBe(undefined)
    expect(store.getState().draftAttachmentPersistence[sourceID]).toBe(undefined)
    expect(store.getState().draftHydration[destinationID]).toBe("degraded")
    expect(store.getState().draftPersistence[destinationID]?.errorCode).toBe("quota")
    expect(store.getState().draftAttachmentViews[destinationID]).toEqual({ source: {} })
    expect(store.getState().draftMissingAttachmentRefIDs[destinationID]).toEqual(["missing"])
    expect(store.getState().draftAttachmentPersistence[destinationID]?.errorCode).toBe("transaction-failed")
  })

  test("replace creates a fresh occurrence reference in one revision", async () => {
    const { store } = await createStore()
    const first = await store.getState().addDraftLocalAttachment(key(), new File(["one"], "one.txt"))
    const before = store.getState().getDraft(key())!.revision
    const replacement = await store.getState().replaceDraftAttachment(key(), first!.attachmentRefID, new File(["two"], "two.txt"))
    expect(replacement?.attachmentRefID).not.toBe(first?.attachmentRefID)
    expect(store.getState().getDraft(key())!.revision).toBe(before + 1)
  })
})
