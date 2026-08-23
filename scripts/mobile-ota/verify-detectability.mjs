#!/usr/bin/env node
/**
 * Assert that a freshly published OTA bundle is DETECTABLE by real clients.
 *
 * Manifest/bundle reachability is not enough: the check endpoint must answer
 * `apply_ota` for an existing shell and `none` for a device already on the
 * bundle. This script replays three device profiles against
 * POST /v1/mobile/update/check and fails the release when any of them regresses:
 *
 *   1. Old iOS shell — iOS TestFlight strips `-beta.N` from the marketing
 *      version, so the probe sends the stripped form plus the minimum viable
 *      native build and `currentBundleId: builtin`.
 *   2. Old Android shell — full semver nativeVersion, minimum viable build.
 *   3. iOS Capgo builtin marketing version — `currentBundleId` equals the
 *      stripped CFBundleShortVersionString (`1.18.2`). Must still `apply_ota`
 *      on beta; this is what a real TestFlight shell reports today.
 *   4. Device already on the bundle — `currentBundleId` set to the release
 *      version; must answer `none` so clients do not re-offer forever.
 *
 * Usage (repo root):
 *   node scripts/mobile-ota/verify-detectability.mjs --channel beta \
 *     --version 1.18.2-beta.66 --mode ota [--base https://openchamber-update.vercel.app]
 *
 * `--mode ota` expects profiles 1+2 to see `apply_ota` (web-only release:
 * existing shells must update in place). `--mode native` expects
 * `install_native_required` (the floor was raised: shells must reinstall).
 *
 * The check endpoint may briefly serve a pre-deploy manifest (edge cache), so
 * probes retry for up to ~3 minutes before failing.
 */
const DEFAULT_BASE = 'https://openchamber-update.vercel.app'

function parseArgs(argv) {
  const out = { channel: 'beta', version: null, mode: 'ota', base: process.env.OTA_BASE_URL || DEFAULT_BASE }
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key === '--channel') out.channel = value
    else if (key === '--version') out.version = value
    else if (key === '--mode') out.mode = value
    else if (key === '--base') out.base = value
    else throw new Error(`Unknown argument: ${key}`)
  }
  if (!out.version) throw new Error('--version is required')
  if (out.channel !== 'beta' && out.channel !== 'stable') throw new Error('--channel must be beta or stable')
  if (out.mode !== 'ota' && out.mode !== 'native') throw new Error('--mode must be ota or native')
  return out
}

const { channel, version, mode, base } = parseArgs(process.argv.slice(2))

const RETRY_DELAYS_MS = [0, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000]

const stripPrerelease = (v) => v.replace(/-[0-9A-Za-z.+-]+$/, '')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchManifest() {
  const response = await fetch(`${base}/ota/channels/${channel}.json`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`manifest fetch failed: ${response.status}`)
  return response.json()
}

async function probe(body) {
  const response = await fetch(`${base}/v1/mobile/update/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`check endpoint failed: ${response.status}`)
  return response.json()
}

function buildProfiles(manifest) {
  const active = manifest.activeBundle
  if (!active) throw new Error('activeBundle is null — nothing to detect')
  if (active.releaseVersion !== version) {
    throw new Error(`activeBundle.releaseVersion is ${active.releaseVersion}, expected ${version}`)
  }
  const shellApi = Number.isInteger(active.minShellApiVersion) ? active.minShellApiVersion : 1

  const profiles = []
  for (const platform of ['ios', 'android']) {
    const minBuild = active.platforms?.[platform]?.minNativeBuild ?? 1
    // Old-shell build: at the bundle's floor for ota mode (must still update
    // in place), one below the floor for native mode (must reinstall). The
    // ota-mode assumption nativeTarget.build > minBuild holds because ota
    // releases never raise the floor while nativeTargets only move on native
    // releases.
    const oldBuild = mode === 'native' ? Math.max(1, minBuild - 1) : minBuild
    profiles.push({
      name: `${platform} old shell (${mode})`,
      body: {
        channel,
        platform,
        deviceId: `ci-detectability-${platform}`,
        // iOS marketing versions strip the prerelease suffix; Android keeps it.
        nativeVersion: platform === 'ios' ? stripPrerelease(version) : version,
        nativeBuild: oldBuild,
        shellApiVersion: shellApi,
        currentBundleId: 'builtin',
      },
      expect: mode === 'native' ? 'install_native_required' : 'apply_ota',
    })
  }
  if (mode === 'ota') {
    profiles.push({
      name: 'iOS Capgo builtin marketing version',
      body: {
        channel,
        platform: 'ios',
        deviceId: 'ci-detectability-ios-marketing',
        nativeVersion: stripPrerelease(version),
        nativeBuild: active.platforms?.ios?.minNativeBuild ?? 1,
        shellApiVersion: shellApi,
        currentBundleId: stripPrerelease(version),
      },
      expect: 'apply_ota',
    })
  }
  profiles.push({
    name: 'device already on bundle',
    body: {
      channel,
      platform: 'android',
      deviceId: 'ci-detectability-current',
      nativeVersion: version,
      nativeBuild: active.platforms?.android?.minNativeBuild ?? 1,
      shellApiVersion: shellApi,
      // Clients report the running bundle by version name as well as bundleId.
      currentBundleId: version,
    },
    expect: 'none',
  })
  return profiles
}

let lastFailures = []
for (const delay of RETRY_DELAYS_MS) {
  if (delay > 0) await sleep(delay)
  const profiles = buildProfiles(await fetchManifest())
  lastFailures = []
  for (const profile of profiles) {
    try {
      const decision = await probe(profile.body)
      const actual = decision.primaryAction
      if (actual !== profile.expect) {
        lastFailures.push(`${profile.name}: expected ${profile.expect}, got ${actual}`)
      } else if (profile.expect === 'apply_ota' && decision.ota?.bundle?.releaseVersion !== version) {
        lastFailures.push(`${profile.name}: apply_ota offers ${decision.ota?.bundle?.releaseVersion ?? 'none'}, expected ${version}`)
      } else {
        console.log(`  ok ${profile.name} -> ${actual}`)
      }
    } catch (error) {
      lastFailures.push(`${profile.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (lastFailures.length === 0) {
    console.log(`detectability verified: ${channel} ${version} (mode=${mode})`)
    process.exit(0)
  }
  console.log(`  stale/mismatch (${lastFailures.length}), retrying...`)
}

console.error('::error::OTA detectability verification failed:')
for (const failure of lastFailures) console.error(`  - ${failure}`)
process.exit(1)
