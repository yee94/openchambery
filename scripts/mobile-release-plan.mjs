#!/usr/bin/env node
/**
 * Decide whether a mobile change is OTA-eligible (web bundle only) or requires
 * a native shell rebuild. Compares the working tree against the latest stable/
 * beta `v*` tag, checks native fingerprint paths, and validates bridge contracts
 * against Swift/Java plugin sources.
 *
 * Usage (repo root):
 *   node scripts/mobile-release-plan.mjs [--json] [--base <tag>]
 *
 * Exit code is 0 unless a real tooling error occurs. CI reads `mode` from JSON.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const NATIVE_PREFIXES = [
  'packages/mobile/ios/',
  'packages/mobile/android/',
]

/** Generated Cap sync artifacts — excluded from the native fingerprint. */
const FINGERPRINT_EXCLUDES = new Set([
  'packages/mobile/ios/App/App/capacitor.config.json',
  'packages/mobile/ios/App/Podfile.lock',
  'packages/mobile/android/app/src/main/assets/capacitor.config.json',
  'packages/mobile/android/capacitor.settings.gradle',
  'packages/mobile/android/app/capacitor.build.gradle',
])

const TAG_PATTERN = /^v\d+\.\d+\.\d+(-beta\.\d+)?$/

function parseArgs(argv) {
  const out = { json: false, base: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') out.json = true
    else if (arg === '--base') {
      out.base = argv[++i] ?? null
      if (!out.base) throw new Error('--base requires a tag value')
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/mobile-release-plan.mjs [--json] [--base <tag>]')
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return out
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim()
}

/** Parse `vX.Y.Z` or `vX.Y.Z-beta.N` into comparable parts. Stable > any beta of same X.Y.Z. */
function parseSemverTag(tag) {
  const match = tag.match(/^v(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    beta: match[4] === undefined ? null : Number(match[4]),
  }
}

function compareSemverTags(a, b) {
  const A = parseSemverTag(a)
  const B = parseSemverTag(b)
  if (!A || !B) return 0
  if (A.major !== B.major) return A.major - B.major
  if (A.minor !== B.minor) return A.minor - B.minor
  if (A.patch !== B.patch) return A.patch - B.patch
  if (A.beta === null && B.beta === null) return 0
  if (A.beta === null) return 1
  if (B.beta === null) return -1
  return A.beta - B.beta
}

function latestBaseTag() {
  // CI checks out the tag being released, so that tag points at HEAD and
  // would be selected as the highest base — diffing a tag against itself is
  // always empty and every release would read as `ota`. Exclude tags that
  // point at HEAD so the base falls to the PREVIOUS release. Local dev HEADs
  // (no tag) keep selecting the latest tag as before.
  const headTags = new Set(
    git(['tag', '--points-at', 'HEAD'])
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean),
  )
  const tags = git(['tag', '-l', 'v*'])
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => TAG_PATTERN.test(t) && !headTags.has(t))
  if (tags.length === 0) {
    throw new Error('No matching base tags found (expected vX.Y.Z or vX.Y.Z-beta.N)')
  }
  tags.sort(compareSemverTags)
  return tags[tags.length - 1]
}

function collectChangedPaths(baseTag) {
  const changed = new Set()

  // Working tree + index vs base (covers unstaged and staged edits).
  const diff = git(['diff', '--name-only', baseTag], { stdio: ['ignore', 'pipe', 'pipe'] })
  for (const line of diff.split('\n')) {
    const p = line.trim()
    if (p) changed.add(p)
  }

  // Untracked / added paths not present in the base diff.
  const status = git(['status', '--porcelain'])
  for (const line of status.split('\n')) {
    if (!line.trim()) continue
    // Porcelain: XY PATH or XY ORIG -> PATH for renames.
    const rest = line.slice(3)
    const arrow = rest.indexOf(' -> ')
    const filePath = arrow === -1 ? rest.trim() : rest.slice(arrow + 4).trim()
    if (filePath) changed.add(filePath)
  }

  return [...changed].sort()
}

function isFingerprintPath(filePath) {
  const underNative = NATIVE_PREFIXES.some((prefix) => filePath.startsWith(prefix))
  if (!underNative) return false
  if (FINGERPRINT_EXCLUDES.has(filePath)) return false
  return true
}

function readShellApiVersion() {
  const configPath = path.join(ROOT, 'packages/mobile/capacitor.config.ts')
  const source = readFileSync(configPath, 'utf8')
  // Prefer an explicit assignment when present; default to 1 until OTA config lands.
  const match = source.match(/shellApiVersion\s*[:=]\s*(\d+)/)
  if (match) return Number(match[1])
  return 1
}

function extractSwiftSurface(source) {
  const methods = new Set()
  const events = new Set()
  for (const match of source.matchAll(/@objc\s+func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    methods.add(match[1])
  }
  // Direct: notifyListeners("name", …)
  for (const match of source.matchAll(/notifyListeners\(\s*"([^"]+)"/g)) {
    events.add(match[1])
  }
  // Ternary: notifyListeners(cond ? "a" : "b", …)
  for (const match of source.matchAll(/notifyListeners\(\s*[^,)]*\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g)) {
    events.add(match[1])
    events.add(match[2])
  }
  return { methods: [...methods].sort(), events: [...events].sort() }
}

function extractJavaSurface(source) {
  const methods = new Set()
  const events = new Set()
  // Match @PluginMethod … public void name( across optional annotations/whitespace.
  for (const match of source.matchAll(/@PluginMethod(?:\([^)]*\))?\s*(?:public\s+)?void\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    methods.add(match[1])
  }
  for (const match of source.matchAll(/notifyListeners\(\s*"([^"]+)"/g)) {
    events.add(match[1])
  }
  // OpenChamberNavigationPlugin forwards progress via notifyListeners(eventName, …)
  // where eventName is the string literal passed into notifyProgress("backStarted"|…).
  for (const match of source.matchAll(/notifyProgress\(\s*"([^"]+)"/g)) {
    events.add(match[1])
  }
  return { methods: [...methods].sort(), events: [...events].sort() }
}

function setDiff(expected, actual) {
  const exp = new Set(expected)
  const act = new Set(actual)
  const missing = [...exp].filter((x) => !act.has(x)).sort()
  const extra = [...act].filter((x) => !exp.has(x)).sort()
  return { missing, extra }
}

async function validateContracts() {
  const { mobileBridgeContracts } = await import(
    pathToFileURL(path.join(ROOT, 'packages/mobile/contracts/index.mjs')).href
  )

  const changedContracts = []
  let contractsValid = true

  for (const contract of mobileBridgeContracts) {
    const platforms = contract.platforms ?? []
    for (const platform of platforms) {
      const sources = contract.sources?.[platform] ?? []
      if (sources.length === 0) {
        contractsValid = false
        changedContracts.push(`${contract.pluginName}.${platform}:missing_source`)
        continue
      }

      const merged = { methods: new Set(), events: new Set() }
      for (const rel of sources) {
        const abs = path.join(ROOT, rel)
        if (!existsSync(abs)) {
          contractsValid = false
          changedContracts.push(`${contract.pluginName}.${platform}:missing_file:${rel}`)
          continue
        }
        const text = readFileSync(abs, 'utf8')
        const surface = platform === 'ios' ? extractSwiftSurface(text) : extractJavaSurface(text)
        for (const m of surface.methods) merged.methods.add(m)
        for (const e of surface.events) merged.events.add(e)
      }

      const expectedMethods = contract.methods?.[platform] ?? []
      const expectedEvents = contract.events?.[platform] ?? []
      const methodDiff = setDiff(expectedMethods, [...merged.methods])
      const eventDiff = setDiff(expectedEvents, [...merged.events])

      for (const name of methodDiff.missing) {
        contractsValid = false
        changedContracts.push(`${contract.pluginName}.${name}:missing_${platform}`)
      }
      for (const name of methodDiff.extra) {
        contractsValid = false
        changedContracts.push(`${contract.pluginName}.${name}:extra_${platform}`)
      }
      for (const name of eventDiff.missing) {
        contractsValid = false
        changedContracts.push(`${contract.pluginName}.${name}:missing_event_${platform}`)
      }
      for (const name of eventDiff.extra) {
        contractsValid = false
        changedContracts.push(`${contract.pluginName}.${name}:extra_event_${platform}`)
      }
    }
  }

  return { contractsValid, changedContracts: [...new Set(changedContracts)].sort() }
}

function printHuman(plan) {
  console.log(`mode: ${plan.mode}`)
  console.log(`reason: ${plan.reason}`)
  console.log(`baseTag: ${plan.baseTag}`)
  console.log(`shellApiVersion: ${plan.shellApiVersion}`)
  console.log(`contractsValid: ${plan.contractsValid}`)
  if (plan.changedNativePaths.length > 0) {
    console.log('changedNativePaths:')
    for (const p of plan.changedNativePaths) console.log(`  - ${p}`)
  } else {
    console.log('changedNativePaths: (none)')
  }
  if (plan.changedContracts.length > 0) {
    console.log('changedContracts:')
    for (const c of plan.changedContracts) console.log(`  - ${c}`)
  } else {
    console.log('changedContracts: (none)')
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const baseTag = args.base ?? latestBaseTag()
  if (!parseSemverTag(baseTag)) {
    throw new Error(`Invalid base tag: ${baseTag}`)
  }

  const allChanged = collectChangedPaths(baseTag)
  const changedNativePaths = allChanged.filter(isFingerprintPath)
  const { contractsValid, changedContracts } = await validateContracts()
  const shellApiVersion = readShellApiVersion()

  let mode = 'ota'
  let reason = 'ok'
  if (!contractsValid) {
    mode = 'native'
    reason = 'bridge_contract_changed'
  } else if (changedNativePaths.length > 0) {
    mode = 'native'
    reason = 'native_fingerprint_changed'
  }

  const plan = {
    mode,
    reason,
    baseTag,
    changedNativePaths,
    changedContracts,
    shellApiVersion,
    contractsValid,
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
  } else {
    printHuman(plan)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
