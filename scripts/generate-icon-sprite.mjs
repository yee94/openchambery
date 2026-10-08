/**
 * Generates the SVG icon sprite file from Lucide (Codex-style stroke icons).
 *
 * Usage: bun run scripts/generate-icon-sprite.mjs
 *
 * Scans packages/ui/src for Icon name="..." / IconName usages, maps OpenChamber
 * kebab names → Lucide glyphs via scripts/icon-name-map.mjs, and writes
 * packages/ui/src/components/icon/sprite.ts.
 *
 * Brand marks without Lucide equivalents fall back to embedded SVG markup in
 * the map. Remixicon remains only as a last-resort path extractor for any
 * unmapped legacy Ri* imports still present in source.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { ICON_NAME_MAP } from "./icon-name-map.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, "..")
const lucideIconsDir = resolve(repoRoot, "node_modules/lucide-static/icons")
const remixPath = resolve(repoRoot, "node_modules/@remixicon/react/index.mjs")
const outPath = resolve(repoRoot, "packages/ui/src/components/icon/sprite.ts")
const srcDir = resolve(repoRoot, "packages/ui/src")

if (!existsSync(lucideIconsDir)) {
  console.error("lucide-static not found. Run: bun add -d lucide-static")
  process.exit(1)
}

// --- Lucide SVG extraction ---
function readLucideInner(lucideName) {
  const filePath = resolve(lucideIconsDir, `${lucideName}.svg`)
  if (!existsSync(filePath)) return null
  const raw = readFileSync(filePath, "utf-8")
  const match = raw.match(/<svg\b[^>]*>([\s\S]*?)<\/svg>/i)
  if (!match) return null
  // Strip XML comments / excess whitespace; keep element markup.
  return match[1]
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/** Bake solid fill onto Lucide stroke paths for *-fill OpenChamber names. */
function applyFillVariant(inner) {
  return inner
    .replace(/<path\b([^>]*?)(\/?)>/g, (full, attrs, selfClose) => {
      if (/\bfill=/.test(attrs)) return full
      return `<path${attrs} fill="currentColor"${selfClose}>`
    })
    .replace(/<circle\b([^>]*?)(\/?)>/g, (full, attrs, selfClose) => {
      if (/\bfill=/.test(attrs)) return full
      return `<circle${attrs} fill="currentColor"${selfClose}>`
    })
}

// --- Optional Remixicon fallback (brands / unmapped Ri* only) ---
const varPathMap = new Map()
const nameToVar = new Map()
const spriteNameToRi = new Map()

if (existsSync(remixPath)) {
  const source = readFileSync(remixPath, "utf-8")
  const varRegex = /(?:[,;]const |\),)([A-Za-z0-9_$]{1,4})=\([{]color:/g
  const varPositions = []
  let m
  while ((m = varRegex.exec(source)) !== null) {
    varPositions.push({
      varName: m[1],
      start: m.index + m[0].length - 1,
    })
  }

  for (let i = 0; i < varPositions.length; i++) {
    const current = varPositions[i]
    const next = varPositions[i + 1]
    const end = next
      ? source.indexOf("))," + next.varName + "=(", current.start)
      : source.length
    if (end < 0 || end < current.start) continue
    const segment = source.slice(current.start, end)
    const pathRegex = /\w+\.createElement\("path",[{]d:"([^"]*)"/g
    let pm
    const paths = []
    while ((pm = pathRegex.exec(segment)) !== null) {
      paths.push(pm[1])
    }
    if (paths.length > 0) {
      varPathMap.set(current.varName, paths)
    }
  }

  const exportMatch = /export[{]([^}]+)[}]/.exec(source)
  if (exportMatch) {
    for (const entry of exportMatch[1].split(",")) {
      const parts = entry.trim().split(" as ")
      if (parts.length === 2) {
        nameToVar.set(parts[1].trim(), parts[0].trim())
      }
    }
  }

  const remixToSpriteName = (name) =>
    name
      .replace(/^Ri/, "")
      .replace(/Line$/, "")
      .replace(/([a-z])([A-Z0-9])/g, "$1-$2")
      .replace(/([0-9])([A-Z])/g, "$1-$2")
      .toLowerCase()

  const hasRemixVariantSuffix = (name) => name.endsWith("Line") || name.endsWith("Fill")
  const shouldPreferSpriteCandidate = (current, candidate) => {
    if (!current) return true
    if (!hasRemixVariantSuffix(candidate) && hasRemixVariantSuffix(current)) return true
    if (!hasRemixVariantSuffix(current)) return false
    if (candidate.endsWith("Line") && !current.endsWith("Line")) return true
    return false
  }

  for (const iconName of nameToVar.keys()) {
    const spriteName = remixToSpriteName(iconName)
    const current = spriteNameToRi.get(spriteName)
    if (shouldPreferSpriteCandidate(current, iconName)) {
      spriteNameToRi.set(spriteName, iconName)
    }
  }
}

function remixInnerForKebab(kebab) {
  const riName = spriteNameToRi.get(kebab)
  if (!riName) return null
  const varName = nameToVar.get(riName)
  if (!varName) return null
  const paths = varPathMap.get(varName)
  if (!paths?.length) return null
  return paths.map((d) => `<path d="${d}" fill="currentColor" stroke="none"/>`).join("")
}

// --- Scan packages/ui/src for used kebab icon names ---
function findAllSourceFiles(dir) {
  const results = []
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry)
    try {
      const st = statSync(full)
      if (st.isDirectory()) {
        if (entry === "node_modules") continue
        results.push(...findAllSourceFiles(full))
      } else if (/\.(tsx?)$/.test(entry) && full !== outPath) {
        results.push(full)
      }
    } catch {
      /* skip */
    }
  }
  return results
}

function nameToRi(kebab) {
  const parts = kebab.split("-")
  let result = "Ri"
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (i > 0 && /^\d/.test(part)) {
      result += part[0].toUpperCase() + part.slice(1)
    } else {
      result += part.charAt(0).toUpperCase() + part.slice(1)
    }
  }
  return result
}

const usedKebab = new Set()

const addKebabIcon = (kebab) => {
  if (!kebab || typeof kebab !== "string") return false
  if (!/^[a-z][a-z0-9-]*$/.test(kebab)) return false
  // Only accept names we know how to render (map or remix fallback).
  if (ICON_NAME_MAP[kebab] || spriteNameToRi.has(kebab)) {
    usedKebab.add(kebab)
    return true
  }
  // Also accept if a Ri* Line/Fill variant exists for this kebab.
  for (const suffix of ["Line", "Fill", ""]) {
    const riName = nameToRi(kebab) + suffix
    if (nameToVar.has(riName)) {
      usedKebab.add(kebab)
      return true
    }
  }
  return false
}

function findMatchingBrace(content, openBraceIndex) {
  let depth = 0
  let quote = null
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let i = openBraceIndex; i < content.length; i++) {
    const char = content[i]
    const next = content[i + 1]

    if (lineComment) {
      if (char === "\n") lineComment = false
      continue
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false
        i++
      }
      continue
    }

    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === "/" && next === "/") {
      lineComment = true
      i++
      continue
    }

    if (char === "/" && next === "*") {
      blockComment = true
      i++
      continue
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char
      continue
    }

    if (char === "{") {
      depth++
    } else if (char === "}") {
      depth--
      if (depth === 0) return i
    }
  }

  return -1
}

const addIconNameFunctionReturns = (content) => {
  const functionRegex = /function\s+\w+\s*\([^)]*\)\s*:\s*IconName(?:\s*\|\s*null)?\s*{/g
  let match
  while ((match = functionRegex.exec(content)) !== null) {
    const openBraceIndex = content.indexOf("{", match.index)
    if (openBraceIndex === -1) continue

    const closeBraceIndex = findMatchingBrace(content, openBraceIndex)
    if (closeBraceIndex === -1) continue

    const body = content.slice(openBraceIndex + 1, closeBraceIndex)
    const returnRegex = /\breturn\s+["']([a-z][a-z0-9-]*)["']/g
    let returnMatch
    while ((returnMatch = returnRegex.exec(body)) !== null) {
      addKebabIcon(returnMatch[1])
    }
    functionRegex.lastIndex = closeBraceIndex + 1
  }
}

const addTypedIconNameRecords = (content) => {
  const recordRegex = /:\s*Record<[^>]*IconName[^>]*>\s*=\s*{/g
  let match
  while ((match = recordRegex.exec(content)) !== null) {
    const openBraceIndex = content.indexOf("{", match.index)
    if (openBraceIndex === -1) continue

    const closeBraceIndex = findMatchingBrace(content, openBraceIndex)
    if (closeBraceIndex === -1) continue

    const body = content.slice(openBraceIndex + 1, closeBraceIndex)
    const iconLiteralRegex = /["']([a-z][a-z0-9-]*)["']/g
    let literal
    while ((literal = iconLiteralRegex.exec(body)) !== null) {
      addKebabIcon(literal[1])
    }
    recordRegex.lastIndex = closeBraceIndex + 1
  }
}

const addIconNameVariableAssignments = (content) => {
  if (!/<Icon\b/.test(content)) return

  const variableRegex = /\b(?:const|let|var)\s+\w*IconName\b[^=]*=\s*([\s\S]*?);/g
  let match
  while ((match = variableRegex.exec(content)) !== null) {
    const initializer = match[1]
    const directLiteral = /^\s*["']([a-z][a-z0-9-]*)["']/.exec(initializer)
    if (directLiteral) {
      addKebabIcon(directLiteral[1])
    }

    const branchLiteralRegex = /(?:\?\?|[?:])\s*["']([a-z][a-z0-9-]*)["']/g
    let branchLiteral
    while ((branchLiteral = branchLiteralRegex.exec(initializer)) !== null) {
      addKebabIcon(branchLiteral[1])
    }
  }
}

const remixToSpriteName = (name) =>
  name
    .replace(/^Ri/, "")
    .replace(/Line$/, "")
    .replace(/([a-z])([A-Z0-9])/g, "$1-$2")
    .replace(/([0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()

for (const file of findAllSourceFiles(srcDir)) {
  const content = readFileSync(file, "utf-8")

  // Legacy Ri* imports → kebab via remix naming
  const iconRegex = /Ri[A-Z][A-Za-z0-9]+/g
  let im
  while ((im = iconRegex.exec(content)) !== null) {
    if (nameToVar.has(im[0])) {
      addKebabIcon(remixToSpriteName(im[0]))
    }
  }

  const iconNameRegex = /<Icon\b[^>]*\bname=(?:["']([^"']+)["']|{\s*["']([^"']+)["']\s*})/g
  let nm
  while ((nm = iconNameRegex.exec(content)) !== null) {
    addKebabIcon(nm[1] || nm[2])
  }

  const iconPropRegex = /\b[Ii]con:\s*["']([a-z][a-z0-9-]*)["']/g
  let ip
  while ((ip = iconPropRegex.exec(content)) !== null) {
    addKebabIcon(ip[1])
  }

  const iconJsxPropRegex = /\b[Ii]con=(?:["']([^"']+)["']|{\s*["']([^"']+)["']\s*})/g
  let jp
  while ((jp = iconJsxPropRegex.exec(content)) !== null) {
    addKebabIcon(jp[1] || jp[2])
  }

  addIconNameFunctionReturns(content)
  addTypedIconNameRecords(content)
  addIconNameVariableAssignments(content)
}

// Always include every mapped icon so IconName stays complete for typed configs.
for (const kebab of Object.keys(ICON_NAME_MAP)) {
  usedKebab.add(kebab)
}

console.log(`Found ${usedKebab.size} unique icon names to pack`)

// --- Build sprite entries ---
const iconEntries = []
const missing = []

for (const kebab of [...usedKebab].sort()) {
  const entry = ICON_NAME_MAP[kebab]

  if (entry?.brand) {
    iconEntries.push({ name: kebab, content: entry.brand, kind: "brand" })
    continue
  }

  // Codex-style custom glyphs (e.g. classic tabbed folder — readable at 14–16px).
  if (entry?.custom) {
    iconEntries.push({ name: kebab, content: entry.custom, kind: "custom" })
    continue
  }

  if (entry?.lucide) {
    let inner = readLucideInner(entry.lucide)
    if (!inner) {
      missing.push(`${kebab} → lucide:${entry.lucide}`)
      continue
    }
    if (entry.fill) {
      inner = applyFillVariant(inner)
    }
    iconEntries.push({ name: kebab, content: inner, kind: "lucide" })
    continue
  }

  const remixInner = remixInnerForKebab(kebab)
  if (remixInner) {
    iconEntries.push({ name: kebab, content: remixInner, kind: "remix-fallback" })
    continue
  }

  missing.push(kebab)
}

if (missing.length > 0) {
  console.warn(`\n⚠ Missing ${missing.length} icons:`)
  for (const name of missing) console.warn(`  - ${name}`)
}

const spriteLines = iconEntries.map(
  ({ name, content }) => `  "${name}": \`${content}\`,`
)

const spriteContent = `// This file is auto-generated by scripts/generate-icon-sprite.mjs
// Do not edit manually. Run \`bun run icons:generate\` to update.
// Source: Lucide (stroke) via scripts/icon-name-map.mjs — Codex-style thin icons.

export const iconSpriteData = {
${spriteLines.join("\n")}
} as const satisfies Record<string, string>;
`

writeFileSync(outPath, spriteContent, "utf-8")

const byKind = iconEntries.reduce((acc, e) => {
  acc[e.kind] = (acc[e.kind] || 0) + 1
  return acc
}, {})

console.log(`\n✅ Generated sprite data for ${iconEntries.length} icons → ${outPath}`)
console.log(`   Breakdown: ${JSON.stringify(byKind)}`)
console.log(`   Total sprite size: ${Buffer.byteLength(spriteContent).toLocaleString()} bytes`)
