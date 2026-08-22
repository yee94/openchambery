#!/usr/bin/env node
/**
 * Assemble a deployable OTA snapshot directory from a Capgo zip + channel metadata.
 *
 * Writes:
 *   <out>/ota/bundles/<bundleId>.zip
 *   <out>/ota/channels/<channel>.json
 *   <out>/ota-meta.json
 *
 * Fetches the live channel manifest from OTA_BASE_URL (default EdgeOne host).
 * 404 → start generation 1 with empty rollbacks.
 * Other HTTP errors → abort (never silently reset a live channel).
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
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

function parseArgs(argv) {
  const out = {
    distDir: null,
    version: null,
    channel: 'beta',
    zip: null,
    checksum: null,
    sessionKey: null,
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
      case '--dist-dir':
        out.distDir = next()
        break
      case '--version':
        out.version = next()
        break
      case '--channel':
        out.channel = next()
        break
      case '--zip':
        out.zip = next()
        break
      case '--checksum':
        out.checksum = next()
        break
      case '--session-key':
        out.sessionKey = next()
        break
      case '--out':
        out.out = next()
        break
      case '--help':
      case '-h':
        console.log(
          'Usage: node scripts/mobile-ota/assemble-snapshot.mjs --zip <path> --version <semver> --checksum <hex> --out <dir> [--channel beta] [--session-key <key>] [--dist-dir <dir>]',
        )
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!out.zip || !out.version || !out.checksum || !out.out) {
    throw new Error('--zip, --version, --checksum, and --out are required')
  }
  // Encrypted bundles carry the opaque encrypted checksum from the Capgo CLI;
  // plain bundles must be 64-char hex (optionally sha256:-prefixed) because the
  // native plugin compares this value verbatim against its own hex digest.
  if (out.sessionKey) {
    if (typeof out.checksum !== 'string' || out.checksum.trim().length === 0) {
      throw new Error('--checksum must be the encrypted checksum string when --session-key is used')
    }
    out.checksum = out.checksum.trim()
  } else {
    const raw = out.checksum.trim().toLowerCase()
    const stripped = raw.startsWith('sha256:') ? raw.slice('sha256:'.length) : raw
    if (!/^[0-9a-f]{64}$/.test(stripped)) {
      throw new Error('--checksum must be 64-char hex (optionally sha256:-prefixed)')
    }
    out.checksum = stripped
  }
  return out
}

function readShellApiVersion() {
  const source = readFileSync(path.join(ROOT, 'packages/mobile/capacitor.config.ts'), 'utf8')
  const match = source.match(/shellApiVersion\s*[:=]\s*(\d+)/)
  return match ? Number(match[1]) : 1
}

function sha256FileHex(filePath) {
  const hash = createHash('sha256')
  hash.update(readFileSync(filePath))
  return hash.digest('hex')
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
    return { kind: 'missing', manifest: emptyManifest(channel) }
  }
  if (!response.ok) {
    throw new Error(`Aborting: production channel fetch returned HTTP ${response.status} for ${url}`)
  }

  const body = await response.json()
  if (!body || typeof body !== 'object') {
    throw new Error(`Aborting: production channel manifest is not a JSON object (${url})`)
  }
  return { kind: 'ok', manifest: body }
}

async function downloadBundle(baseUrl, bundleId, destPath) {
  const url = `${baseUrl.replace(/\/$/, '')}/ota/bundles/${bundleId}.zip`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download rollback bundle ${bundleId}: HTTP ${response.status}`)
  }
  mkdirSync(path.dirname(destPath), { recursive: true })
  if (!response.body) {
    writeFileSync(destPath, Buffer.from(await response.arrayBuffer()))
    return
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destPath))
}

function resolveMinNativeBuild(envKey, previousActive, platform) {
  const fromEnv = process.env[envKey]
  if (fromEnv !== undefined && fromEnv !== '') {
    const n = Number.parseInt(fromEnv, 10)
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`${envKey} must be a positive integer`)
    }
    return n
  }
  const prev = previousActive?.platforms?.[platform]?.minNativeBuild
  if (Number.isInteger(prev) && prev >= 1) return prev
  return 1
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const baseUrl = process.env.OTA_BASE_URL || DEFAULT_OTA_BASE
  const rolloutPercent = Number.parseInt(process.env.ROLLOUT_PERCENT ?? '100', 10)
  if (!Number.isInteger(rolloutPercent) || rolloutPercent < 0 || rolloutPercent > 100) {
    throw new Error('ROLLOUT_PERCENT must be an integer from 0 to 100')
  }

  const zipPath = path.resolve(args.zip)
  if (!existsSync(zipPath)) throw new Error(`Zip not found: ${zipPath}`)

  const zipHash = sha256FileHex(zipPath)
  const bundleId = zipHash.slice(0, 16)
  if (!BUNDLE_ID_PATTERN.test(bundleId)) {
    throw new Error(`Computed bundleId is invalid: ${bundleId}`)
  }
  const size = readFileSync(zipPath).byteLength

  const { manifest: previous } = await fetchProductionManifest(baseUrl, args.channel)
  const previousGeneration = Number.isInteger(previous.generation) ? previous.generation : 0
  const generation = previousGeneration + 1
  const previousActive = previous.activeBundle ?? null

  const rollbackBundleIds = []
  if (previousActive?.bundleId) rollbackBundleIds.push(previousActive.bundleId)
  if (Array.isArray(previous.rollbackBundleIds)) {
    for (const id of previous.rollbackBundleIds) {
      if (typeof id === 'string' && BUNDLE_ID_PATTERN.test(id) && !rollbackBundleIds.includes(id)) {
        rollbackBundleIds.push(id)
      }
    }
  }
  const trimmedRollbacks = rollbackBundleIds.slice(0, 2)

  const minShellApiVersion = readShellApiVersion()
  const activeBundle = {
    bundleId,
    releaseVersion: args.version,
    url: `/ota/bundles/${bundleId}.zip`,
    size,
    checksum: args.checksum,
    rolloutPercent,
    rolloutSalt: `${args.channel}-${generation}`,
    minShellApiVersion,
    platforms: {
      ios: {
        minNativeBuild: resolveMinNativeBuild('MIN_NATIVE_BUILD_IOS', previousActive, 'ios'),
      },
      android: {
        minNativeBuild: resolveMinNativeBuild('MIN_NATIVE_BUILD_ANDROID', previousActive, 'android'),
      },
    },
  }
  if (args.sessionKey) {
    activeBundle.sessionKey = args.sessionKey
  }

  const nextManifest = {
    schemaVersion: 1,
    channel: args.channel,
    generation,
    activeBundle,
    nativeTargets: previous.nativeTargets && typeof previous.nativeTargets === 'object'
      ? { ...previous.nativeTargets }
      : {},
    rollbackBundleIds: trimmedRollbacks,
  }

  const outRoot = path.resolve(args.out)
  const bundlesDir = path.join(outRoot, 'ota', 'bundles')
  const channelsDir = path.join(outRoot, 'ota', 'channels')
  mkdirSync(bundlesDir, { recursive: true })
  mkdirSync(channelsDir, { recursive: true })

  copyFileSync(zipPath, path.join(bundlesDir, `${bundleId}.zip`))

  for (const id of trimmedRollbacks) {
    const dest = path.join(bundlesDir, `${id}.zip`)
    if (existsSync(dest)) continue
    await downloadBundle(baseUrl, id, dest)
  }

  writeFileSync(
    path.join(channelsDir, `${args.channel}.json`),
    `${JSON.stringify(nextManifest, null, 2)}\n`,
  )

  const meta = {
    bundleId,
    generation,
    channel: args.channel,
    releaseVersion: args.version,
    checksum: args.checksum,
    size,
    rollbackBundleIds: trimmedRollbacks,
    previousGeneration,
    sessionKeyPresent: Boolean(args.sessionKey),
  }
  writeFileSync(path.join(outRoot, 'ota-meta.json'), `${JSON.stringify(meta, null, 2)}\n`)

  console.log(`Assembled OTA snapshot at ${outRoot}`)
  console.log(`  bundleId=${bundleId} generation=${generation} rollbacks=${trimmedRollbacks.join(',') || '(none)'}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
