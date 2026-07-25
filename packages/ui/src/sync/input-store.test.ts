import { beforeEach, describe, expect, test } from "bun:test"
import { useInputStore } from "./input-store"
import { sessionDraftKey } from "./input-draft-types"

class MockFileReader {
  result: string | ArrayBuffer | null = null
  onload: ((this: FileReader, event: ProgressEvent<FileReader>) => unknown) | null = null
  onerror: ((this: FileReader, event: ProgressEvent<FileReader>) => unknown) | null = null
  onabort: ((this: FileReader, event: ProgressEvent<FileReader>) => unknown) | null = null
  error: DOMException | null = null

  readAsDataURL() {
    pendingReaders.push(this)
  }
}

const pendingReaders: MockFileReader[] = []
const originalFileReader = globalThis.FileReader

const restoreFileReader = () => {
  pendingReaders.length = 0
  globalThis.FileReader = originalFileReader
}

const testWithMockFileReader = (name: string, fn: () => Promise<void>) => {
  test(name, async () => {
    try {
      await fn()
    } finally {
      restoreFileReader()
    }
  })
}

const resolveReader = (reader: MockFileReader, result: string) => {
  reader.result = result
  reader.onload?.call(reader as unknown as FileReader, {} as ProgressEvent<FileReader>)
}

const rejectReader = (reader: MockFileReader) => {
  reader.error = new DOMException("read failed", "NotReadableError")
  reader.onerror?.call(reader as unknown as FileReader, {} as ProgressEvent<FileReader>)
}

describe("input-store attachments", () => {
  beforeEach(() => {
    pendingReaders.length = 0
    globalThis.FileReader = MockFileReader as unknown as typeof FileReader
    useInputStore.setState({
      pendingInputText: null,
      pendingInputMode: "replace",
      pendingSyntheticParts: null,
      activeEditorFile: null,
      attachmentBuckets: { "legacy-unowned": [] },
      activeAttachmentDraft: null,
      attachedFiles: [],
      drafts: {},
      tombstones: {},
      draftAttachmentViews: {},
      draftMissingAttachmentRefIDs: {},
      draftHydration: {},
      draftPersistence: {},
      draftAttachmentPersistence: {},
    })
    useInputStore.getState().setActiveAttachmentDraft(null)
    useInputStore.getState().setAttachedFiles([])
  })

  testWithMockFileReader("does not attach a local file that finishes reading after attachments are cleared", async () => {
    const addPromise = useInputStore.getState().addAttachedFile(new File(["hello"], "hello.txt", { type: "text/plain" }))
    expect(pendingReaders).toHaveLength(1)

    useInputStore.getState().clearAttachedFiles()
    resolveReader(pendingReaders[0], "data:text/plain;base64,aGVsbG8=")
    await addPromise

    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  testWithMockFileReader("does not attach a local file after attached files are replaced", async () => {
    const addPromise = useInputStore.getState().addAttachedFile(new File(["hello"], "hello.txt", { type: "text/plain" }))
    expect(pendingReaders).toHaveLength(1)

    useInputStore.getState().setAttachedFiles([])
    resolveReader(pendingReaders[0], "data:text/plain;base64,aGVsbG8=")
    await addPromise

    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  testWithMockFileReader("does not attach a local file after attached files are restored", async () => {
    const addPromise = useInputStore.getState().addAttachedFile(new File(["hello"], "hello.txt", { type: "text/plain" }))
    expect(pendingReaders).toHaveLength(1)

    const restored = new File(["restored"], "restored.txt", { type: "text/plain" })
    useInputStore.getState().setAttachedFiles([{
      id: "restored",
      file: restored,
      dataUrl: "data:text/plain;base64,cmVzdG9yZWQ=",
      mimeType: "text/plain",
      filename: "restored.txt",
      size: restored.size,
      source: "local",
    }])
    resolveReader(pendingReaders[0], "data:text/plain;base64,aGVsbG8=")
    await addPromise

    expect(useInputStore.getState().attachedFiles.map((file) => file.filename)).toEqual(["restored.txt"])
  })

  testWithMockFileReader("does not attach a VS Code selection that finishes reading after attachments are cleared", async () => {
    const addPromise = useInputStore.getState().addVSCodeSelectionAttachment(
      "/workspace/hello.txt",
      new File(["hello"], "hello.txt", { type: "text/plain" })
    )
    expect(pendingReaders).toHaveLength(1)

    useInputStore.getState().clearAttachedFiles()
    resolveReader(pendingReaders[0], "data:text/plain;base64,aGVsbG8=")
    await addPromise

    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  test("does not leave local file reads pending after a reader error", async () => {
    const addPromise = useInputStore.getState().addAttachedFile(new File(["hello"], "hello.txt", { type: "text/plain" }))
    expect(pendingReaders).toHaveLength(1)

    rejectReader(pendingReaders[0])
    await addPromise

    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  test("cleans up pending VS Code selection keys after a reader error", async () => {
    const file = new File(["hello"], "hello.txt", { type: "text/plain" })
    const firstAdd = useInputStore.getState().addVSCodeSelectionAttachment("/workspace/hello.txt", file)
    expect(pendingReaders).toHaveLength(1)

    rejectReader(pendingReaders[0])
    await firstAdd

    const secondAdd = useInputStore.getState().addVSCodeSelectionAttachment("/workspace/hello.txt", file)
    expect(pendingReaders).toHaveLength(2)
    resolveReader(pendingReaders[1], "data:text/plain;base64,aGVsbG8=")
    await secondAdd

    expect(useInputStore.getState().attachedFiles.map((attached) => attached.filename)).toEqual(["hello.txt"])
  })

  testWithMockFileReader("routes delayed local attach into the source DraftKey across a session switch", async () => {
    const sessionA = sessionDraftKey({ transportIdentity: "runtime-input-test" }, "ses_a")
    const sessionB = sessionDraftKey({ transportIdentity: "runtime-input-test" }, "ses_b")
    useInputStore.getState().setActiveAttachmentDraft(sessionA)

    const addPromise = useInputStore.getState().addAttachedFile(new File(["a"], "a.txt", { type: "text/plain" }))
    useInputStore.getState().setActiveAttachmentDraft(sessionB)
    resolveReader(pendingReaders[0], "data:text/plain;base64,YQ==")
    await addPromise

    expect(useInputStore.getState().getDraftAttachmentViews(sessionB).map((file) => file.filename)).toEqual([])
    expect(useInputStore.getState().getDraftAttachmentViews(sessionA).map((file) => file.filename)).toEqual(["a.txt"])
    expect(useInputStore.getState().getDraft(sessionA)?.attachments).toHaveLength(1)
  })

  testWithMockFileReader("isolates DraftKey attachments between active sessions", async () => {
    const sessionA = sessionDraftKey({ transportIdentity: "runtime-input-test" }, "ses_a")
    const sessionB = sessionDraftKey({ transportIdentity: "runtime-input-test" }, "ses_b")
    useInputStore.getState().setActiveAttachmentDraft(sessionA)
    const addA = useInputStore.getState().addAttachedFile(new File(["a"], "a.txt", { type: "text/plain" }))
    resolveReader(pendingReaders[0], "data:text/plain;base64,YQ==")
    await addA

    useInputStore.getState().setActiveAttachmentDraft(sessionB)
    const addB = useInputStore.getState().addAttachedFile(new File(["b"], "b.txt", { type: "text/plain" }))
    resolveReader(pendingReaders[1], "data:text/plain;base64,Yg==")
    await addB

    expect(useInputStore.getState().getDraftAttachmentViews(sessionB).map((file) => file.filename)).toEqual(["b.txt"])
    expect(useInputStore.getState().getDraftAttachmentViews(sessionA).map((file) => file.filename)).toEqual(["a.txt"])
  })

  testWithMockFileReader("invalidates delayed DraftKey reads when the source draft is cleared", async () => {
    const sessionA = sessionDraftKey({ transportIdentity: "runtime-input-test" }, "ses_a")
    const sessionB = sessionDraftKey({ transportIdentity: "runtime-input-test" }, "ses_b")
    useInputStore.getState().setActiveAttachmentDraft(sessionA)
    const addPromise = useInputStore.getState().addAttachedFile(new File(["a"], "a.txt", { type: "text/plain" }))
    useInputStore.getState().clearAttachedFiles()
    useInputStore.getState().setActiveAttachmentDraft(sessionB)
    resolveReader(pendingReaders[0], "data:text/plain;base64,YQ==")
    await addPromise

    expect(useInputStore.getState().getDraftAttachmentViews(sessionA)).toEqual([])
    expect(useInputStore.getState().getDraft(sessionA)?.attachments ?? []).toEqual([])
  })

  testWithMockFileReader("routes legacy addAttachedFile into active DraftKey views", async () => {
    const key = sessionDraftKey({ transportIdentity: "runtime-input-test" }, "ses_route")
    useInputStore.getState().setActiveAttachmentDraft(key)
    const addPromise = useInputStore.getState().addAttachedFile(new File(["hello"], "hello.txt", { type: "text/plain" }))
    resolveReader(pendingReaders[0], "data:text/plain;base64,aGVsbG8=")
    await addPromise

    expect(useInputStore.getState().attachedFiles).toEqual([])
    expect(useInputStore.getState().getDraftAttachmentViews(key).map((file) => file.filename)).toEqual(["hello.txt"])
    expect(useInputStore.getState().getDraft(key)?.attachments).toHaveLength(1)
  })

  test("routes VS Code file attachment into active DraftKey as durable file://", () => {
    const key = sessionDraftKey({ transportIdentity: "runtime-input-test" }, "ses_vscode_file")
    useInputStore.getState().setActiveAttachmentDraft(key)
    useInputStore.getState().addVSCodeFileAttachment("/workspace/hello.ts", "hello.ts", 12)

    const views = useInputStore.getState().getDraftAttachmentViews(key)
    expect(views).toHaveLength(1)
    expect(views[0]?.source).toBe("vscode")
    expect(views[0]?.vscodeSource).toBe("file")
    expect(views[0]?.vscodePath).toBe("/workspace/hello.ts")
    expect(views[0]?.dataUrl.startsWith("file:")).toBe(true)
    expect(useInputStore.getState().getDraft(key)?.attachments[0]?.locator).toEqual({
      kind: "url",
      url: views[0]!.dataUrl,
    })

    useInputStore.getState().addVSCodeFileAttachment("/workspace/hello.ts", "hello.ts", 12)
    expect(useInputStore.getState().getDraftAttachmentViews(key)).toHaveLength(1)
  })

  testWithMockFileReader("routes VS Code selection and code selection into active DraftKey", async () => {
    const key = sessionDraftKey({ transportIdentity: "runtime-input-test" }, "ses_selection")
    useInputStore.getState().setActiveAttachmentDraft(key)
    const selection = useInputStore.getState().addVSCodeSelectionAttachment(
      "/workspace/hello.ts",
      new File(["sel"], "hello.ts:1-2", { type: "text/plain" }),
    )
    resolveReader(pendingReaders[0], "data:text/plain;base64,c2Vs")
    await selection

    const code = useInputStore.getState().addCodeSelectionAttachment(
      "/repo/a.ts",
      "a.ts:3-4",
      "const x = 1",
    )
    resolveReader(pendingReaders[1], "data:text/plain;base64,Y29uc3QgeCA9IDE=")
    await code

    const views = useInputStore.getState().getDraftAttachmentViews(key)
    expect(views.map((file) => file.filename).sort()).toEqual(["a.ts:3-4", "hello.ts:1-2"].sort())
    expect(views.every((file) => file.source === "vscode" && file.vscodeSource === "selection")).toBe(true)
  })

  test("routes restored durable attachment into active DraftKey views", () => {
    const key = sessionDraftKey({ transportIdentity: "runtime-input-test" }, "ses_restored")
    useInputStore.getState().setActiveAttachmentDraft(key)
    useInputStore.getState().addRestoredAttachment({
      url: "file:///fork.txt",
      mimeType: "text/plain",
      filename: "fork.txt",
    })

    const views = useInputStore.getState().getDraftAttachmentViews(key)
    expect(views).toHaveLength(1)
    expect(views[0]?.filename).toBe("fork.txt")
    expect(views[0]?.dataUrl).toBe("file:///fork.txt")
    expect(views[0]?.serverPath).toBe("file:///fork.txt")
    expect(useInputStore.getState().getDraft(key)?.attachments[0]?.locator).toEqual({
      kind: "url",
      url: "file:///fork.txt",
    })
  })

  testWithMockFileReader("removeAttachedFile maps attachmentID to DraftKey attachmentRefID", async () => {
    const key = sessionDraftKey({ transportIdentity: "runtime-input-test" }, "ses_remove")
    useInputStore.getState().setActiveAttachmentDraft(key)
    const addPromise = useInputStore.getState().addAttachedFile(new File(["x"], "x.txt", { type: "text/plain" }))
    resolveReader(pendingReaders[0], "data:text/plain;base64,eA==")
    await addPromise

    const view = useInputStore.getState().getDraftAttachmentViews(key)[0]
    expect(view).toBeDefined()
    useInputStore.getState().removeAttachedFile(view!.id)
    await Promise.resolve()
    expect(useInputStore.getState().getDraftAttachmentViews(key)).toEqual([])
  })

  testWithMockFileReader("clearAttachedFiles clears only root DraftKey attachments", async () => {
    const key = sessionDraftKey({ transportIdentity: "runtime-input-test" }, "ses_clear")
    useInputStore.getState().setActiveAttachmentDraft(key)
    useInputStore.getState().ensureDraft(key)
    useInputStore.getState().setDraftSyntheticParts(key, [{ partID: "part", text: "ctx", attachments: [] }])
    const rootAdd = useInputStore.getState().addAttachedFile(new File(["root"], "root.txt", { type: "text/plain" }))
    resolveReader(pendingReaders[0], "data:text/plain;base64,cm9vdA==")
    await rootAdd
    const syntheticAdd = useInputStore.getState().addDraftLocalAttachment(
      key,
      new File(["syn"], "syn.txt", { type: "text/plain" }),
      { partID: "part" },
    )
    expect(pendingReaders).toHaveLength(2)
    resolveReader(pendingReaders[1], "data:text/plain;base64,c3lu")
    await syntheticAdd

    useInputStore.getState().clearAttachedFiles()
    expect(useInputStore.getState().getDraft(key)?.attachments).toEqual([])
    expect(useInputStore.getState().getDraft(key)?.syntheticParts[0]?.attachments.length).toBeGreaterThan(0)
  })

  testWithMockFileReader("null activeAttachmentDraft still uses legacy-unowned bucket", async () => {
    useInputStore.getState().setActiveAttachmentDraft(null)
    const addPromise = useInputStore.getState().addAttachedFile(new File(["legacy"], "legacy.txt", { type: "text/plain" }))
    resolveReader(pendingReaders[0], "data:text/plain;base64,bGVnYWN5")
    await addPromise

    expect(useInputStore.getState().attachedFiles.map((file) => file.filename)).toEqual(["legacy.txt"])
    expect(useInputStore.getState().attachmentBuckets["legacy-unowned"]?.map((file) => file.filename)).toEqual(["legacy.txt"])
  })
})
