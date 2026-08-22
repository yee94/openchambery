#!/usr/bin/env node
/**
 * Mutate the production beta (or named) OTA channel manifest and write a
 * deployable snapshot. Bundle zip files are content-addressed; this script
 * re-fetches active + rollback zips into <out>/ota/bundles/ so a full Vercel
 * static replace still serves them.
 *
 * Actions:
 *   --action promote --percent N
 *   --action pause
 *   --action rollback
 *   --action set-native-target --platform ios|android --version V --build N
 *     [--status published] [--url U]
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')

const DEFAULT_OTA_BASE = 'https://openchamber.xiaobe.top'
const BUNDLE_ID_PATTERN = /^[0-9a-f]{16}$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function parseArgs(argv) {
  const out = {
    action: null,
    percent: null,
    platform: null,
    version: null,
    build: null,
    status: 'published',
    url: null,
    channel: 'beta',
    out: null,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${arg} requires a value`)
      return v
    }
    switch (arg) {
      case '--action':
        out.action = next()
        break
      case '--percent':
        out.percent = Number.parseInt(next(), 10)
        break
      case '--platform':
        out.platform = next()
        break
      case '--version':
        out.version = next()
        break
      case '--build':
        out.build = Number.parseInt(next(), 10)
        break
      case '--status':
        out.status = next()
        break
      case '--url':
        out.url = next()
        break
      case '--channel':
        out.channel = next()
        break
      case '--out':
        out.out = next()
        break
      case '--help':
      case '-h':
        console.log(`Usage:
  node scripts/mobile-ota/rollout.mjs --action promote --percent N --out <dir>
  node scripts/mobile-ota/rollout.mjs --action pause --out <dir>
  node scripts/mobile-ota/rollout.mjs --action rollback --out <dir>
  node scripts/mobile-ota/rollout.mjs --action set-native-target --platform ios|android --version V --build N [--url U] --out <dir>`)
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!out.action) throw new Error('--action is required')
  if (!out.out) throw new Error('--out is required')
  return out
}

function emptyManifest(channel) {
  return {
    schemaVersion: 1,
    channel,
    generation: 0,
    activeBundle: null,
    nativeTargets: {},
    rollbackBundleIds: [],
  }
}

async function fetchProductionManifest(baseUrl, channel) {
  const url = `${baseUrl.replace(/\/$/, '')}/ota/channels/${channel}.json`
  let response
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' } })
  } catch (error) {
    throw new Error(`Failed to fetch ${url}: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (response.status === 404) {
    return emptyManifest(channel)
  }
  if (!response.ok) {
    throw new Error(`Aborting: production channel fetch returned HTTP ${response.status} for ${url}`)
  }
  const body = await response.json()
  if (!body || typeof body !== 'object') {
    throw new Error(`Aborting: production channel manifest is not a JSON object (${url})`)
  }
  return body
}

async function downloadBundle(baseUrl, bundleId, destPath) {
  const url = `${baseUrl.replace(/\/$/, '')}/ota/bundles/${bundleId}.zip`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download bundle ${bundleId}: HTTP ${response.status}`)
  }
  mkdirSync(path.dirname(destPath), { recursive: true })
  if (!response.body) {
    const { writeFileSync: write } = await import('node:fs')
    write(destPath, Buffer.from(await response.arrayBuffer()))
    return
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destPath))
}

function applyPromote(manifest, percent) {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new Error('--percent must be an integer from 0 to 100')
  }
  if (!manifest.activeBundle) {
    throw new Error('Cannot promote: activeBundle is null')
  }
  const next = structuredClone(manifest)
  next.generation = (Number.isInteger(manifest.generation) ? manifest.generation : 0) + 1
  next.activeBundle.rolloutPercent = percent
  next.activeBundle.rolloutSalt = `${next.channel}-${next.generation}`
  return next
}

function applyPause(manifest) {
  return applyPromote(manifest, 0)
}

function applyRollback(manifest) {
  if (!Array.isArray(manifest.rollbackBundleIds) || manifest.rollbackBundleIds.length === 0) {
    throw new Error('Cannot rollback: rollbackBundleIds is empty')
  }
  const targetId = manifest.rollbackBundleIds[0]
  if (typeof targetId !== 'string' || !BUNDLE_ID_PATTERN.test(targetId)) {
    throw new Error(`Invalid rollback bundle id: ${targetId}`)
  }
  if (!manifest.activeBundle) {
    throw new Error('Cannot rollback: activeBundle is null (nothing to demote)')
  }

  const demoted = structuredClone(manifest.activeBundle)
  const next = structuredClone(manifest)
  next.generation = (Number.isInteger(manifest.generation) ? manifest.generation : 0) + 1
  // Stash for finalizeRollback — recomputes checksum/size from the downloaded zip
  // and restores a publishable activeBundle for targetId.
  next._rollbackTargetId = targetId
  next._demotedActive = demoted
  next.rollbackBundleIds = [demoted.bundleId, ...manifest.rollbackBundleIds.slice(1)]
    .filter((id, index, arr) => arr.indexOf(id) === index)
    .slice(0, 2)
  return next
}

function applySetNativeTarget(manifest, args) {
  if (args.platform !== 'ios' && args.platform !== 'android') {
    throw new Error('--platform must be ios or android')
  }
  if (!args.version || !VERSION_PATTERN.test(args.version)) {
    throw new Error('--version must be a semver string')
  }
  if (!Number.isInteger(args.build) || args.build < 1) {
    throw new Error('--build must be a positive integer')
  }

  const next = structuredClone(manifest)
  next.generation = (Number.isInteger(manifest.generation) ? manifest.generation : 0) + 1
  if (!next.nativeTargets || typeof next.nativeTargets !== 'object') {
    next.nativeTargets = {}
  }
  const target = {
    version: args.version,
    build: args.build,
  }
  if (args.status) target.status = args.status
  if (args.url) target.installUrl = args.url
  next.nativeTargets[args.platform] = target
  return next
}

async function finalizeRollback(next, baseUrl, bundlesDir) {
  const targetId = next._rollbackTargetId
  const demoted = next._demotedActive
  delete next._rollbackTargetId
  delete next._demotedActive

  const zipPath = path.join(bundlesDir, `${targetId}.zip`)
  if (!existsSync(zipPath)) {
    await downloadBundle(baseUrl, targetId, zipPath)
  }

  const { createHash } = await import('node:crypto')
  const { readFileSync } = await import('node:fs')
  const bytes = readFileSync(zipPath)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const size = bytes.byteLength

  next.activeBundle = {
    bundleId: targetId,
    releaseVersion: demoted.releaseVersion,
    url: `/ota/bundles/${targetId}.zip`,
    size,
    // Plain hex — the native plugin compares this verbatim against its digest.
    // NOTE: rolling back an encrypted bundle re-serves the encrypted zip with a
    // plain checksum; shells with a configured public key cannot verify it and
    // will fall back (autoRevert) to their previous good bundle.
    checksum: digest,
    rolloutPercent: 100,
    rolloutSalt: `${next.channel}-${next.generation}`,
    minShellApiVersion: demoted.minShellApiVersion ?? 1,
    platforms: demoted.platforms ?? {
      ios: { minNativeBuild: 1 },
      android: { minNativeBuild: 1 },
    },
  }
  if (demoted.sessionKey) {
    // Session keys are bound to the encrypted payload; omit on plain rollback zip.
  }
  return next
}

async function ensureBundles(manifest, baseUrl, bundlesDir) {
  const ids = []
  if (manifest.activeBundle?.bundleId) ids.push(manifest.activeBundle.bundleId)
  if (Array.isArray(manifest.rollbackBundleIds)) {
    for (const id of manifest.rollbackBundleIds) {
      if (typeof id === 'string' && BUNDLE_ID_PATTERN.test(id)) ids.push(id)
    }
  }
  for (const id of [...new Set(ids)]) {
    const dest = path.join(bundlesDir, `${id}.zip`)
    if (existsSync(dest)) continue
    await downloadBundle(baseUrl, id, dest)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const baseUrl = process.env.OTA_BASE_URL || DEFAULT_OTA_BASE
  const previous = await fetchProductionManifest(baseUrl, args.channel)

  let next
  switch (args.action) {
    case 'promote':
      next = applyPromote(previous, args.percent)
      break
    case 'pause':
      next = applyPause(previous)
      break
    case 'rollback':
      next = applyRollback(previous)
      break
    case 'set-native-target':
      next = applySetNativeTarget(previous, args)
      break
    default:
      throw new Error(`Unknown action: ${args.action}`)
  }

  const outRoot = path.resolve(args.out)
  const bundlesDir = path.join(outRoot, 'ota', 'bundles')
  const channelsDir = path.join(outRoot, 'ota', 'channels')
  mkdirSync(bundlesDir, { recursive: true })
  mkdirSync(channelsDir, { recursive: true })

  if (args.action === 'rollback') {
    next = await finalizeRollback(next, baseUrl, bundlesDir)
  }

  await ensureBundles(next, baseUrl, bundlesDir)

  writeFileSync(
    path.join(channelsDir, `${args.channel}.json`),
    `${JSON.stringify(next, null, 2)}\n`,
  )

  const meta = {
    action: args.action,
    channel: args.channel,
    generation: next.generation,
    previousGeneration: previous.generation ?? 0,
    activeBundleId: next.activeBundle?.bundleId ?? null,
    rolloutPercent: next.activeBundle?.rolloutPercent ?? null,
    nativeTargets: next.nativeTargets,
  }
  writeFileSync(path.join(outRoot, 'ota-meta.json'), `${JSON.stringify(meta, null, 2)}\n`)

  console.log(`Wrote rollout snapshot at ${outRoot}`)
  console.log(`  action=${args.action} generation=${next.generation}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
