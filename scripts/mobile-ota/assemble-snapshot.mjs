#!/usr/bin/env node
/**
 * Assemble a deployable OTA snapshot directory from a Capgo zip + channel metadata.
 *
 * Writes:
 *   <out>/ota/bundles/<bundleId>.zip
 *   <out>/ota/channels/<channel>.json
 *   <out>/ota/channels/<other>.json   (full-snapshot mirror)
 *   <out>/ota-meta.json
 *
 * Fetches the live channel manifest from OTA_BASE_URL (default: the Vercel
 * origin that CI auto-deploys — the authoritative OTA source of truth).
 * 404 → start generation 1 with empty rollbacks.
 * Other HTTP errors → abort (never silently reset a live channel).
 *
 * FULL-SNAPSHOT: every deploy replaces static output, so the snapshot always
 * includes BOTH channel manifests and all referenced bundles.
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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')

// CI deploys snapshots to Vercel; it is the authoritative OTA origin. The
// EdgeOne host stays client-readable as a legacy mirror but never as write source.
const DEFAULT_OTA_BASE = 'https://openchamber-update.vercel.app'
const BUNDLE_ID_PATTERN = /^[0-9a-f]{16}$/
const ALLOWED_CHANNELS = new Set(['beta', 'stable'])

const { parseOtaManifest } = await import(
  pathToFileURL(path.join(ROOT, 'deploy/update-service/lib/ota-manifest.js')).href
)
const { compareReleaseVersions } = await import(
  pathToFileURL(path.join(ROOT, 'deploy/update-service/lib/semver.js')).href
)

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
          'Usage: node scripts/mobile-ota/assemble-snapshot.mjs --zip <path> --version <semver> --checksum <hex> --out <dir> [--channel beta|stable] [--session-key <key>] [--dist-dir <dir>]',
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
  if (!ALLOWED_CHANNELS.has(out.channel)) {
    throw new Error(`--channel must be beta or stable (got "${out.channel}")`)
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

function otherChannel(channel) {
  return channel === 'beta' ? 'stable' : 'beta'
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
  const parsed = parseOtaManifest(body)
  if (!parsed.ok) {
    throw new Error(`Aborting: production channel manifest invalid (${url}): ${parsed.errors.join('; ')}`)
  }
  if (parsed.manifest.channel !== channel) {
    throw new Error(`Aborting: production channel field mismatch (${url}): expected ${channel}, got ${parsed.manifest.channel}`)
  }
  return { kind: 'ok', manifest: parsed.manifest }
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

/** Fetch active + rollback zips for a channel manifest into bundlesDir (skip existing). */
async function ensureChannelBundles(manifest, baseUrl, bundlesDir) {
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

/**
 * Mirror the OTHER channel into the snapshot so a full static replace does not
 * delete it. 404 → write null-seed; other errors → abort; success → validate + write.
 */
async function mirrorOtherChannel(baseUrl, targetChannel, channelsDir, bundlesDir) {
  const other = otherChannel(targetChannel)
  const { kind, manifest } = await fetchProductionManifest(baseUrl, other)
  writeFileSync(
    path.join(channelsDir, `${other}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  if (kind === 'ok') {
    await ensureChannelBundles(manifest, baseUrl, bundlesDir)
  }
  return { other, kind, generation: manifest.generation }
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
  if (previousActive?.releaseVersion) {
    const comparison = compareReleaseVersions(args.version, previousActive.releaseVersion)
    if (comparison !== null && comparison < 0) {
      throw new Error(
        `Refusing to publish OTA ${args.version} older than active ${previousActive.releaseVersion}`,
      )
    }
  }

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

  await ensureChannelBundles(
    { activeBundle: null, rollbackBundleIds: trimmedRollbacks },
    baseUrl,
    bundlesDir,
  )

  writeFileSync(
    path.join(channelsDir, `${args.channel}.json`),
    `${JSON.stringify(nextManifest, null, 2)}\n`,
  )

  const mirrored = await mirrorOtherChannel(baseUrl, args.channel, channelsDir, bundlesDir)

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
    mirroredChannel: mirrored.other,
    mirroredKind: mirrored.kind,
  }
  writeFileSync(path.join(outRoot, 'ota-meta.json'), `${JSON.stringify(meta, null, 2)}\n`)

  console.log(`Assembled OTA snapshot at ${outRoot}`)
  console.log(`  bundleId=${bundleId} generation=${generation} rollbacks=${trimmedRollbacks.join(',') || '(none)'}`)
  console.log(`  mirrored ${mirrored.other} (${mirrored.kind}, generation=${mirrored.generation})`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
