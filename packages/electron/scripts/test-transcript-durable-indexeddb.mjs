import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const fixtureEntry = path.join(packageRoot, "scripts/transcript-durable-indexeddb-renderer.ts")
const electronHarness = path.join(packageRoot, "scripts/transcript-durable-indexeddb-electron.mjs")
const electronBinary = path.join(packageRoot, "node_modules/.bin/electron")
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openchamber-transcript-durable-indexeddb-"))
const fixtureDirectory = path.join(temporaryRoot, "fixture")
const userDataDirectory = path.join(temporaryRoot, "user-data")

try {
  const build = await Bun.build({
    entrypoints: [fixtureEntry],
    outdir: fixtureDirectory,
    target: "browser",
    format: "iife",
    naming: "renderer.js",
  })
  if (!build.success) throw new Error(build.logs.map((log) => log.message).join("\n"))
  const fixturePath = path.join(fixtureDirectory, "index.html")
  await fs.writeFile(fixturePath, "<!doctype html><script src=\"./renderer.js\"></script>")
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const electron = Bun.spawn([
    electronBinary,
    "--headless",
    "--disable-gpu",
    electronHarness,
    "--",
    fixturePath,
    userDataDirectory,
  ], {
    cwd: packageRoot,
    env: environment,
    stdout: "inherit",
    stderr: "inherit",
  })
  if (await electron.exited !== 0) throw new Error("Electron Chromium IndexedDB evidence failed")
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true })
}
