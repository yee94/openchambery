#!/usr/bin/env node
/**
 * Mutate a production OTA channel manifest and write a deployable snapshot.
 * Bundle zip files are content-addressed; this script re-fetches active +
 * rollback zips into <out>/ota/bundles/ so a full Vercel static replace still
 * serves them.
 *
 * FULL-SNAPSHOT: every deploy replaces static output, so the snapshot always
 * includes BOTH channel manifests and all referenced bundles.
 *
 * Actions:
 *   --action promote --percent N [--channel beta|stable]
 *   --action pause [--channel beta|stable]
 *   --action rollback [--channel beta|stable]
 *   --action set-native-target --platform ios|android --version V --build N
 *     [--status published] [--url U] [--channel beta|stable]
 *   --action set-min-shell-release-version --version V|"" [--channel beta|stable]
 *     Sets or clears activeBundle.minShellReleaseVersion (empty string clears).
 *   --action set-min-native-build --platform ios|android --build N [--channel beta|stable]
 *     DEPRECATED: Sets activeBundle.platforms.<platform>.minNativeBuild.
 *     Server-side check no longer reads this field; kept for repairing legacy
 *     manifests. Prefer set-min-shell-release-version.
 *   --action promote-channel --from beta --to stable [--percent 100]
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
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
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const ALLOWED_CHANNELS = new Set(['beta', 'stable'])

const { parseOtaManifest } = await import(
  pathToFileURL(path.join(ROOT, 'deploy/update-service/lib/ota-manifest.js')).href
)

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
    from: null,
    to: null,
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
      case '--from':
        out.from = next()
        break
      case '--to':
        out.to = next()
        break
      case '--out':
        out.out = next()
        break
      case '--help':
      case '-h':
        console.log(`Usage:
  node scripts/mobile-ota/rollout.mjs --action promote --percent N --out <dir> [--channel beta|stable]
  node scripts/mobile-ota/rollout.mjs --action pause --out <dir> [--channel beta|stable]
  node scripts/mobile-ota/rollout.mjs --action rollback --out <dir> [--channel beta|stable]
  node scripts/mobile-ota/rollout.mjs --action set-native-target --platform ios|android --version V --build N [--url U] --out <dir> [--channel beta|stable]
  node scripts/mobile-ota/rollout.mjs --action set-min-shell-release-version --version V|"" --out <dir> [--channel beta|stable]
  node scripts/mobile-ota/rollout.mjs --action set-min-native-build --platform ios|android --build N --out <dir> [--channel beta|stable]
  node scripts/mobile-ota/rollout.mjs --action promote-channel --from beta --to stable [--percent 100] --out <dir>`)
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!out.action) throw new Error('--action is required')
  if (!out.out) throw new Error('--out is required')
  if (out.action === 'promote-channel') {
    if (!out.from || !out.to) throw new Error('promote-channel requires --from and --to')
    if (!ALLOWED_CHANNELS.has(out.from) || !ALLOWED_CHANNELS.has(out.to)) {
      throw new Error('--from and --to must be beta or stable')
    }
    if (out.from === out.to) throw new Error('--from and --to must differ')
  } else if (!ALLOWED_CHANNELS.has(out.channel)) {
    throw new Error(`--channel must be beta or stable (got "${out.channel}")`)
  }
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

function applySetMinShellReleaseVersion(manifest, args) {
  if (!manifest.activeBundle) {
    throw new Error('Cannot set min shell release version: activeBundle is null')
  }
  // Empty / omitted --version clears the gate (no shell floor).
  const raw = args.version
  const clearing = raw === null || raw === undefined || raw === ''
  if (!clearing && !VERSION_PATTERN.test(raw)) {
    throw new Error('--version must be a semver string, or empty to clear minShellReleaseVersion')
  }

  const next = structuredClone(manifest)
  next.generation = (Number.isInteger(manifest.generation) ? manifest.generation : 0) + 1
  if (clearing) {
    delete next.activeBundle.minShellReleaseVersion
  } else {
    next.activeBundle.minShellReleaseVersion = raw
  }
  return next
}

// DEPRECATED: 服务端判定已不再读取 platforms.*.minNativeBuild；仅保留用于修复线上存量 manifest。
// 新的壳门请用 set-min-shell-release-version（activeBundle.minShellReleaseVersion）。
function applySetMinNativeBuild(manifest, args) {
  if (args.platform !== 'ios' && args.platform !== 'android') {
    throw new Error('--platform must be ios or android')
  }
  if (!Number.isInteger(args.build) || args.build < 1) {
    throw new Error('--build must be a positive integer')
  }
  if (!manifest.activeBundle) {
    throw new Error('Cannot set min native build: activeBundle is null')
  }

  const next = structuredClone(manifest)
  next.generation = (Number.isInteger(manifest.generation) ? manifest.generation : 0) + 1
  next.activeBundle.platforms = next.activeBundle.platforms || {}
  next.activeBundle.platforms[args.platform] = next.activeBundle.platforms[args.platform] || {}
  next.activeBundle.platforms[args.platform].minNativeBuild = args.build
  return next
}

function applyPromoteChannel(sourceManifest, targetManifest, percent) {
  if (!sourceManifest.activeBundle) {
    throw new Error('Cannot promote-channel: source activeBundle is null')
  }
  const resolvedPercent = percent === null || percent === undefined ? 100 : percent
  if (!Number.isInteger(resolvedPercent) || resolvedPercent < 0 || resolvedPercent > 100) {
    throw new Error('--percent must be an integer from 0 to 100')
  }

  const sourceActive = sourceManifest.activeBundle
  const previousGeneration = Number.isInteger(targetManifest.generation) ? targetManifest.generation : 0
  const generation = previousGeneration + 1

  const rollbackBundleIds = []
  if (targetManifest.activeBundle?.bundleId) {
    rollbackBundleIds.push(targetManifest.activeBundle.bundleId)
  }
  if (Array.isArray(targetManifest.rollbackBundleIds)) {
    for (const id of targetManifest.rollbackBundleIds) {
      if (typeof id === 'string' && BUNDLE_ID_PATTERN.test(id) && !rollbackBundleIds.includes(id)) {
        rollbackBundleIds.push(id)
      }
    }
  }

  // Copy source activeBundle VERBATIM, then override rollout salt/percent only.
  const activeBundle = {
    ...structuredClone(sourceActive),
    rolloutPercent: resolvedPercent,
    rolloutSalt: `${targetManifest.channel}-${generation}`,
  }

  return {
    schemaVersion: 1,
    channel: targetManifest.channel,
    generation,
    activeBundle,
    nativeTargets: targetManifest.nativeTargets && typeof targetManifest.nativeTargets === 'object'
      ? structuredClone(targetManifest.nativeTargets)
      : {},
    rollbackBundleIds: rollbackBundleIds.slice(0, 2),
  }
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

async function mirrorOtherChannel(baseUrl, targetChannel, channelsDir, bundlesDir) {
  const other = otherChannel(targetChannel)
  const { kind, manifest } = await fetchProductionManifest(baseUrl, other)
  writeFileSync(
    path.join(channelsDir, `${other}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  if (kind === 'ok') {
    await ensureBundles(manifest, baseUrl, bundlesDir)
  }
  return { other, kind, generation: manifest.generation }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const baseUrl = process.env.OTA_BASE_URL || DEFAULT_OTA_BASE

  const outRoot = path.resolve(args.out)
  const bundlesDir = path.join(outRoot, 'ota', 'bundles')
  const channelsDir = path.join(outRoot, 'ota', 'channels')
  mkdirSync(bundlesDir, { recursive: true })
  mkdirSync(channelsDir, { recursive: true })

  let next
  let previous
  let writeChannel

  if (args.action === 'promote-channel') {
    const source = await fetchProductionManifest(baseUrl, args.from)
    const target = await fetchProductionManifest(baseUrl, args.to)
    previous = target.manifest
    next = applyPromoteChannel(source.manifest, target.manifest, args.percent)
    writeChannel = args.to

    // Source channel is the "other" relative to the written target — mirror it
    // from the already-fetched source (not a second production fetch) so the
    // snapshot keeps the proven beta (or from) channel intact.
    writeFileSync(
      path.join(channelsDir, `${args.from}.json`),
      `${JSON.stringify(source.manifest, null, 2)}\n`,
    )
    await ensureBundles(source.manifest, baseUrl, bundlesDir)
  } else {
    const fetched = await fetchProductionManifest(baseUrl, args.channel)
    previous = fetched.manifest
    writeChannel = args.channel

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
      case 'set-min-shell-release-version':
        next = applySetMinShellReleaseVersion(previous, args)
        break
      case 'set-min-native-build':
        // DEPRECATED: 见 applySetMinNativeBuild 注释；服务端判定已不读 minNativeBuild。
        next = applySetMinNativeBuild(previous, args)
        break
      default:
        throw new Error(`Unknown action: ${args.action}`)
    }
  }

  if (args.action === 'rollback') {
    next = await finalizeRollback(next, baseUrl, bundlesDir)
  }

  await ensureBundles(next, baseUrl, bundlesDir)

  writeFileSync(
    path.join(channelsDir, `${writeChannel}.json`),
    `${JSON.stringify(next, null, 2)}\n`,
  )

  let mirrored = null
  if (args.action !== 'promote-channel') {
    mirrored = await mirrorOtherChannel(baseUrl, writeChannel, channelsDir, bundlesDir)
  }

  const meta = {
    action: args.action,
    channel: writeChannel,
    generation: next.generation,
    previousGeneration: previous.generation ?? 0,
    activeBundleId: next.activeBundle?.bundleId ?? null,
    rolloutPercent: next.activeBundle?.rolloutPercent ?? null,
    nativeTargets: next.nativeTargets,
    ...(args.action === 'promote-channel'
      ? { from: args.from, to: args.to }
      : { mirroredChannel: mirrored?.other, mirroredKind: mirrored?.kind }),
  }
  writeFileSync(path.join(outRoot, 'ota-meta.json'), `${JSON.stringify(meta, null, 2)}\n`)

  console.log(`Wrote rollout snapshot at ${outRoot}`)
  console.log(`  action=${args.action} channel=${writeChannel} generation=${next.generation}`)
  if (args.action === 'promote-channel') {
    console.log(`  promoted ${args.from} → ${args.to} bundleId=${next.activeBundle?.bundleId} percent=${next.activeBundle?.rolloutPercent}`)
  } else if (mirrored) {
    console.log(`  mirrored ${mirrored.other} (${mirrored.kind}, generation=${mirrored.generation})`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
