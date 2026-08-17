import { describe, expect, test } from "bun:test"
import { readdir, readFile, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))

const WRITE_ROOTS = [
  here,
  join(here, "../lib/api/types.ts"),
  join(here, "../lib/messageFreshness.ts"),
  join(here, "../lib/runtime-fetch.test.ts"),
  join(here, "../stores/globalSessions.ts"),
  join(here, "../stores/useGlobalSessionsStore.ts"),
  join(here, "../stores/globalSessions.test.ts"),
  join(here, "../stores/useGlobalSessionsStore.test.ts"),
]

const IMPORT_BANNED = [
  /from\s+['"]@opencode-ai\/sdk(?:\/[^'"]*)?['"]/,
  /createOpencodeClient/,
]

const RUNTIME_BANNED = [
  /experimental\.session\.list/,
  /sdk\(\)\.session\.messages/,
  /sdk\(\)\.session\.abort/,
  /\.session\.children\(/,
  /sdk\.global\.event/,
  /assertSdkSuccess/,
  /assertSdkData/,
]

async function collectTsFiles(entry: string): Promise<string[]> {
  const info = await stat(entry)
  if (info.isFile()) return entry.endsWith(".ts") || entry.endsWith(".tsx") ? [entry] : []
  const names = await readdir(entry)
  const files: string[] = []
  for (const name of names) {
    if (name === "node_modules" || name === "DOCUMENTATION.md") continue
    files.push(...await collectTsFiles(join(entry, name)))
  }
  return files
}

describe("phase 7 UI sync v2 cutover residuals", () => {
  test("write-scope imports do not use @opencode-ai/sdk or createOpencodeClient", async () => {
    const files = (await Promise.all(WRITE_ROOTS.map(collectTsFiles))).flat()
    const hits: string[] = []
    for (const file of files) {
      const source = await readFile(file, "utf8")
      const importLines = source.split("\n").filter((line: string) => /^\s*import\b/.test(line))
      for (const line of importLines) {
        if (IMPORT_BANNED.some((pattern) => pattern.test(line))) {
          hits.push(`${file}: ${line.trim()}`)
        }
      }
    }
    expect(hits).toEqual([])
  })

  test("write-scope runtime does not keep HeyAPI unwrap or 1.x session methods", async () => {
    const files = (await Promise.all(WRITE_ROOTS.map(collectTsFiles))).flat()
    const hits: string[] = []
    for (const file of files) {
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx") || file.includes("/__tests__/")) continue
      const source = (await readFile(file, "utf8"))
        .split("\n")
        .filter((line: string) => !/^\s*(\/\/|\*)/.test(line))
        .join("\n")
      for (const pattern of RUNTIME_BANNED) {
        if (pattern.test(source)) hits.push(`${file}: ${pattern}`)
      }
    }
    expect(hits).toEqual([])
  })
})
