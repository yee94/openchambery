import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const fixtureEntry = path.join(packageRoot, "scripts/input-draft-indexeddb-renderer.ts")
const electronHarness = path.join(packageRoot, "scripts/input-draft-indexeddb-electron.mjs")
const electronBinary = path.join(packageRoot, "node_modules/.bin/electron")

export async function runIndexedDbEvidence() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openchamber-input-draft-indexeddb-"))
  const fixtureDirectory = path.join(temporaryRoot, "fixture")
  const userDataDirectory = path.join(temporaryRoot, "user-data")

  try {
    const build = spawnSync("bun", [
      "build",
      fixtureEntry,
      "--outfile",
      path.join(fixtureDirectory, "renderer.js"),
      "--target",
      "browser",
      "--format",
      "iife",
    ], { encoding: "utf8" })
    if (build.status !== 0) throw new Error(build.stderr || build.stdout || "bun build failed")
    const fixturePath = path.join(fixtureDirectory, "index.html")
    await fs.writeFile(fixturePath, "<!doctype html><script src=\"./renderer.js\"></script>")
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    const child = spawn(electronBinary, [electronHarness, "--", fixturePath, userDataDirectory], {
      cwd: packageRoot,
      env: environment,
      stdio: "inherit",
    })
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject)
      child.on("exit", (code) => resolve(code ?? 1))
    })
    if (code !== 0) throw new Error("Electron Chromium IndexedDB evidence failed")
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true })
  }
}
