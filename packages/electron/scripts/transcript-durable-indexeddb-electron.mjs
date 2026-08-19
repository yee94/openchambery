import { app, BrowserWindow } from "electron"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const harnessPath = fileURLToPath(import.meta.url)
const harnessArgumentIndex = process.argv.findIndex((argument) => path.resolve(argument) === harnessPath)
const [fixturePath, userDataPath] = process.argv
  .slice(harnessArgumentIndex + 1)
  .filter((argument) => argument !== "--")

let stage = "boot"
let window
let failed = false

const waitFor = (promise, description, timeout = 45_000) => {
  let timeoutID
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeoutID = setTimeout(() => reject(new Error(`${description} timed out after ${timeout / 1_000} seconds during ${stage}`)), timeout)
    }),
  ]).finally(() => {
    clearTimeout(timeoutID)
  })
}

console.log("Transcript durable IndexedDB harness: boot")
app.disableHardwareAcceleration()
app.commandLine.appendSwitch("headless")
app.commandLine.appendSwitch("disable-gpu")
app.once("will-finish-launching", () => console.log("Transcript durable IndexedDB harness: will-finish-launching"))
app.once("ready", () => console.log("Transcript durable IndexedDB harness: ready"))

const run = async () => {
  if (harnessArgumentIndex < 0 || !fixturePath || !userDataPath) {
    throw new Error(`Expected fixture and temporary user-data paths; received argv: ${JSON.stringify(process.argv)}`)
  }

  const resolvedFixturePath = path.resolve(fixturePath)
  const resolvedUserDataPath = path.resolve(userDataPath)
  console.log(`Transcript durable IndexedDB harness: inputs fixture=${resolvedFixturePath} userData=${resolvedUserDataPath}`)
  app.setPath("userData", resolvedUserDataPath)
  if (!app.requestSingleInstanceLock()) throw new Error("Transcript durable IndexedDB harness could not acquire its temporary user-data single-instance lock")

  stage = "waiting for app ready"
  await waitFor(app.whenReady(), "Electron app readiness")
  stage = "creating hidden window"
  window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
    },
  })
  window.webContents.once("did-finish-load", () => console.log("Transcript durable IndexedDB harness: window load"))
  stage = "loading renderer fixture"
  await waitFor(window.loadURL(pathToFileURL(resolvedFixturePath).href), "Renderer fixture load")
  stage = "running IndexedDB evidence"
  const result = await window.webContents.executeJavaScript("window.__OPENCHAMBER_TRANSCRIPT_DURABLE_INDEXEDDB_EVIDENCE__")
  if (!result?.ok) throw new Error(result?.error ?? "Renderer did not return IndexedDB evidence")
  console.log(`Chromium transcript durable IndexedDB evidence passed: ${result.evidence.map(({ name }) => name).join(", ")}`)
}

run().catch((error) => {
  failed = true
  const detail = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error(`Transcript durable IndexedDB harness failed during ${stage}: ${detail}`)
  if (stage === "waiting for app ready") {
    console.error("Transcript durable IndexedDB harness applied --headless/--disable-gpu and app.disableHardwareAcceleration() before ready; this environment still delivered no Electron lifecycle events after boot.")
  }
}).finally(() => {
  window?.destroy()
  app.releaseSingleInstanceLock()
  app.exit(failed ? 1 : 0)
})
