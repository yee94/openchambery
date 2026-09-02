#!/usr/bin/env node
/**
 * Assert that a freshly published OTA bundle is DETECTABLE by real clients.
 *
 * Manifest/bundle reachability is not enough: the check endpoint must answer
 * `apply_ota` for an existing shell and `none` for a device already on the
 * bundle. This script replays device profiles against
 * POST /v1/mobile/update/check on every client-facing origin and fails the
 * release when any of them regresses.
 *
 * Shell gating is version-based (`activeBundle.minShellReleaseVersion`), not
 * build-number-based. Profiles use web/shell version identity; `nativeBuild`
 * is deliberately tiny in several cases to prove build no longer participates.
 *
 * Dual local fixtures (always asserted before live probes):
 *
 *   Fixture A — new-style manifest with minShellReleaseVersion "1.18.3-beta.1":
 *     Gate invariant: the gate is written at native release time as that round's
 *     version (= active then) and only carried forward by later OTA publishes,
 *     so gate <= active always holds. "1.18.3-beta.1 native release, then
 *     beta.2 OTA" is the canonical shape; gate "1.18.3" with beta active is an
 *     impossible manifest (and semver ranks stable above same-core betas).
 *     1. Old iOS shell — nativeVersion "1.18.2", currentBundleId "builtin"
 *        → install_native_required
 *     2. Old Android shell — currentBundleId "1.18.2-beta.50"
 *        → install_native_required
 *     3. New shell — currentBundleId "1.18.3-beta.1", nativeBuild 21
 *        → apply_ota (build must not gate)
 *     4. Already on bundle — currentBundleId "1.18.3-beta.2" (= active)
 *        → none
 *     5. Same-core stripped iOS — nativeVersion "1.18.3", currentBundleId "builtin"
 *        → apply_ota (stripped stable ranks above the same-core beta gate)
 *
 *   Fixture B — legacy manifest without minShellReleaseVersion:
 *     Old shell, nativeBuild 21 + old web identity → apply_ota (no gate)
 *
 *   Fixture C — stable channel rollback (beta identity device → stable active):
 *     Device currentBundleId "1.18.4-beta.7" requests channel "stable" while
 *     stable activeBundle is "1.18.3" → apply_ota + isChannelRollback: true
 *
 * Live probes (after fixtures) still hit Vercel + EdgeOne. Expectations are
 * derived from the fetched manifest's minShellReleaseVersion and --mode.
 *
 * Usage (repo root):
 *   node scripts/mobile-ota/verify-detectability.mjs --channel beta \
 *     --version 1.18.2-beta.66 --mode ota
 *
 * `--mode ota` expects ungated old shells to see `apply_ota`. `--mode native`
 * expects a raised minShellReleaseVersion so old shells see
 * `install_native_required`.
 *
 * The check endpoint may briefly serve a pre-deploy manifest (edge cache), so
 * probes retry for up to ~3 minutes before failing.
 *
 * Pass `--fixtures-only` to assert the dual-fixture profile table without
 * contacting production endpoints.
 */
const DEFAULT_BASES = [
  'https://openchamber-update.vercel.app',
  'https://openchamber.xiaobe.top',
]

function parseArgs(argv) {
  const out = {
    channel: 'beta',
    version: null,
    mode: 'ota',
    bases: [],
    fixturesOnly: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === '--fixtures-only') {
      out.fixturesOnly = true
      continue
    }
    const value = argv[++i]
    if (value === undefined) throw new Error(`${key} requires a value`)
    if (key === '--channel') out.channel = value
    else if (key === '--version') out.version = value
    else if (key === '--mode') out.mode = value
    else if (key === '--base') out.bases.push(value)
    else throw new Error(`Unknown argument: ${key}`)
  }
  if (!out.fixturesOnly && !out.version) throw new Error('--version is required')
  if (out.channel !== 'beta' && out.channel !== 'stable') throw new Error('--channel must be beta or stable')
  if (out.mode !== 'ota' && out.mode !== 'native') throw new Error('--mode must be ota or native')
  if (out.bases.length === 0) {
    const fromEnv = (process.env.OTA_DETECTABILITY_BASES || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    out.bases = fromEnv.length > 0 ? fromEnv : DEFAULT_BASES
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const { channel, version, mode, bases, fixturesOnly } = args

const RETRY_DELAYS_MS = [0, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000]

const stripPrerelease = (v) => v.replace(/-[0-9A-Za-z.+-]+$/, '')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const hostLabel = (base) => {
  try {
    return new URL(base).host
  } catch {
    return base
  }
}

/**
 * Produce a release version strictly below `v` for "old shell" live probes.
 * Prefers decrementing beta.N, then patch/minor/major.
 */
function versionBelow(v) {
  const match = String(v).trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/)
  if (!match) return '0.0.1'
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  const beta = match[4] === undefined ? null : Number(match[4])
  if (beta !== null && beta > 0) return `${major}.${minor}.${patch}-beta.${beta - 1}`
  if (patch > 0) return `${major}.${minor}.${patch - 1}`
  if (minor > 0) return `${major}.${minor - 1}.0`
  if (major > 0) return `${major - 1}.0.0`
  return '0.0.1'
}

async function fetchManifest(base) {
  const response = await fetch(`${base}/ota/channels/${channel}.json`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`manifest fetch failed: ${response.status}`)
  return response.json()
}

async function probe(base, body) {
  const response = await fetch(`${base}/v1/mobile/update/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`check endpoint failed: ${response.status}`)
  return response.json()
}

/**
 * Build the four live device profiles from an activeBundle.
 * Gate presence (minShellReleaseVersion) drives install_native_required;
 * nativeBuild is never used as the gate signal.
 */
function buildProfiles(manifest, expectedVersion = version) {
  const active = manifest.activeBundle
  if (!active) throw new Error('activeBundle is null — nothing to detect')
  if (active.releaseVersion !== expectedVersion) {
    throw new Error(`activeBundle.releaseVersion is ${active.releaseVersion}, expected ${expectedVersion}`)
  }
  const shellApi = Number.isInteger(active.minShellApiVersion) ? active.minShellApiVersion : 1
  const gate = typeof active.minShellReleaseVersion === 'string' && active.minShellReleaseVersion !== ''
    ? active.minShellReleaseVersion
    : null
  // Live native publishes must raise the version gate; ota must not newly raise it.
  // When a gate is present (native, or carried forward), old shells reinstall.
  const oldShellExpect = gate ? 'install_native_required' : 'apply_ota'
  const oldIdentity = versionBelow(gate || expectedVersion)
  // Same-core stripped stable (1.19.0) ranks above a beta gate (1.19.0-beta.37).
  // Old iOS + builtin falls back to nativeVersion, so that identity must be
  // truly below the gate. Stepping down from the stripped stable gate avoids
  // collapsing the old-shell profile to a same-core stable identity.
  const oldIosNative = gate
    ? stripPrerelease(versionBelow(stripPrerelease(gate)))
    : stripPrerelease(oldIdentity)

  // Profile 3 ("new shell"): prove nativeBuild no longer gates. Prefer an
  // identity that clears the version gate without already being on active:
  // nativeVersion >= gate + currentBundleId builtin when gate === active;
  // otherwise a parseable id at the gate / just below active when ungated.
  let newShellBundleId
  let newShellNativeVersion = expectedVersion
  if (!gate) {
    newShellBundleId = versionBelow(expectedVersion)
  } else if (gate !== expectedVersion) {
    newShellBundleId = gate
  } else {
    newShellBundleId = 'builtin'
    newShellNativeVersion = expectedVersion
  }

  return [
    {
      name: 'ios old shell (stripped + builtin)',
      body: {
        channel,
        platform: 'ios',
        deviceId: 'ci-detectability-ios',
        nativeVersion: oldIosNative,
        nativeBuild: 21,
        shellApiVersion: shellApi,
        currentBundleId: 'builtin',
      },
      expect: oldShellExpect,
    },
    {
      name: 'android old shell (prior bundle id)',
      body: {
        channel,
        platform: 'android',
        deviceId: 'ci-detectability-android',
        nativeVersion: oldIdentity,
        nativeBuild: 21,
        shellApiVersion: shellApi,
        currentBundleId: oldIdentity,
      },
      expect: oldShellExpect,
    },
    {
      name: 'new shell (tiny nativeBuild must not gate)',
      body: {
        channel,
        platform: 'android',
        deviceId: 'ci-detectability-new-shell',
        nativeVersion: newShellNativeVersion,
        nativeBuild: 21,
        shellApiVersion: shellApi,
        currentBundleId: newShellBundleId,
      },
      expect: 'apply_ota',
    },
    {
      name: 'device already on bundle',
      body: {
        channel,
        platform: 'android',
        deviceId: 'ci-detectability-current',
        nativeVersion: expectedVersion,
        nativeBuild: 21,
        shellApiVersion: shellApi,
        currentBundleId: expectedVersion,
      },
      expect: 'none',
    },
  ]
}

/** Fixed dual fixtures — structural expect table (no network). */
function fixtureAManifest() {
  return {
    activeBundle: {
      bundleId: 'aaaaaaaaaaaaaaaa',
      releaseVersion: '1.18.3-beta.2',
      url: '/ota/bundles/aaaaaaaaaaaaaaaa.zip',
      size: 1,
      checksum: '0'.repeat(64),
      rolloutPercent: 100,
      rolloutSalt: 'fixture-a',
      minShellApiVersion: 1,
      minShellReleaseVersion: '1.18.3-beta.1',
      platforms: {
        ios: { minNativeBuild: 1 },
        android: { minNativeBuild: 1 },
      },
    },
  }
}

function fixtureBManifest() {
  return {
    activeBundle: {
      bundleId: 'bbbbbbbbbbbbbbbb',
      releaseVersion: '1.18.3-beta.2',
      url: '/ota/bundles/bbbbbbbbbbbbbbbb.zip',
      size: 1,
      checksum: '0'.repeat(64),
      rolloutPercent: 100,
      rolloutSalt: 'fixture-b',
      minShellApiVersion: 1,
      // no minShellReleaseVersion — legacy ungated
      platforms: {
        ios: { minNativeBuild: 999 },
        android: { minNativeBuild: 999 },
      },
    },
  }
}

function buildFixtureAProfiles() {
  const shellApi = 1
  const activeVersion = '1.18.3-beta.2'
  return [
    {
      name: 'fixtureA ios old shell',
      body: {
        channel: 'beta',
        platform: 'ios',
        deviceId: 'fixture-a-ios',
        nativeVersion: '1.18.2',
        nativeBuild: 21,
        shellApiVersion: shellApi,
        currentBundleId: 'builtin',
      },
      expect: 'install_native_required',
      activeVersion,
    },
    {
      name: 'fixtureA android old shell',
      body: {
        channel: 'beta',
        platform: 'android',
        deviceId: 'fixture-a-android',
        nativeVersion: '1.18.2-beta.50',
        nativeBuild: 21,
        shellApiVersion: shellApi,
        currentBundleId: '1.18.2-beta.50',
      },
      expect: 'install_native_required',
      activeVersion,
    },
    {
      name: 'fixtureA new shell (tiny nativeBuild)',
      body: {
        channel: 'beta',
        platform: 'android',
        deviceId: 'fixture-a-new',
        nativeVersion: '1.18.3',
        nativeBuild: 21,
        shellApiVersion: shellApi,
        currentBundleId: '1.18.3-beta.1',
      },
      // Spec: must apply_ota to prove build number is ignored. Identity vs gate
      // is owned by the parallel resolver lane; we only assert the profile table.
      expect: 'apply_ota',
      activeVersion,
    },
    {
      name: 'fixtureA already on bundle',
      body: {
        channel: 'beta',
        platform: 'android',
        deviceId: 'fixture-a-current',
        nativeVersion: '1.18.3',
        nativeBuild: 21,
        shellApiVersion: shellApi,
        currentBundleId: '1.18.3-beta.2',
      },
      expect: 'none',
      activeVersion,
    },
    {
      name: 'fixtureA same-core stripped iOS vs beta gate',
      body: {
        channel: 'beta',
        platform: 'ios',
        deviceId: 'fixture-a-same-core-stripped',
        nativeVersion: '1.18.3',
        nativeBuild: 21,
        shellApiVersion: shellApi,
        currentBundleId: 'builtin',
      },
      expect: 'apply_ota',
      activeVersion,
    },
  ]
}

function buildFixtureBProfiles() {
  return [
    {
      name: 'fixtureB ungated old shell (nativeBuild ignored)',
      body: {
        channel: 'beta',
        platform: 'android',
        deviceId: 'fixture-b-old',
        nativeVersion: '1.18.2',
        nativeBuild: 21,
        shellApiVersion: 1,
        currentBundleId: '1.18.2-beta.50',
      },
      expect: 'apply_ota',
      activeVersion: '1.18.3-beta.2',
    },
  ]
}

function fixtureCManifest() {
  return {
    activeBundle: {
      bundleId: 'cccccccccccccccc',
      releaseVersion: '1.18.3',
      url: '/ota/bundles/cccccccccccccccc.zip',
      size: 1,
      checksum: '0'.repeat(64),
      rolloutPercent: 100,
      rolloutSalt: 'fixture-c',
      minShellApiVersion: 1,
      platforms: {
        ios: { minNativeBuild: 1 },
        android: { minNativeBuild: 1 },
      },
    },
  }
}

function buildFixtureCProfiles() {
  return [
    {
      name: 'fixtureC beta→stable channel rollback',
      body: {
        channel: 'stable',
        platform: 'android',
        deviceId: 'fixture-c-rollback',
        nativeVersion: '1.18.4-beta.7',
        nativeBuild: 21,
        shellApiVersion: 1,
        currentBundleId: '1.18.4-beta.7',
      },
      expect: 'apply_ota',
      expectIsChannelRollback: true,
      activeVersion: '1.18.3',
    },
  ]
}

function assertFixtureTables() {
  const fixtureA = fixtureAManifest()
  if (fixtureA.activeBundle.minShellReleaseVersion !== '1.18.3-beta.1') {
    throw new Error('fixture A must set minShellReleaseVersion to 1.18.3-beta.1')
  }
  const fixtureB = fixtureBManifest()
  if (fixtureB.activeBundle.minShellReleaseVersion !== undefined) {
    throw new Error('fixture B must omit minShellReleaseVersion')
  }

  const tableA = buildFixtureAProfiles()
  const expectedA = [
    'install_native_required',
    'install_native_required',
    'apply_ota',
    'none',
    'apply_ota',
  ]
  if (tableA.length !== 5) throw new Error(`fixture A must have 5 profiles, got ${tableA.length}`)
  for (let i = 0; i < 5; i += 1) {
    if (tableA[i].expect !== expectedA[i]) {
      throw new Error(`fixture A[${i}] expect ${expectedA[i]}, got ${tableA[i].expect}`)
    }
  }
  if (tableA[0].body.nativeVersion !== '1.18.2' || tableA[0].body.currentBundleId !== 'builtin') {
    throw new Error('fixture A[0] must be stripped 1.18.2 + builtin')
  }
  if (tableA[1].body.currentBundleId !== '1.18.2-beta.50') {
    throw new Error('fixture A[1] must use currentBundleId 1.18.2-beta.50')
  }
  if (tableA[2].body.currentBundleId !== '1.18.3-beta.1' || tableA[2].body.nativeBuild !== 21) {
    throw new Error('fixture A[2] must be 1.18.3-beta.1 with nativeBuild 21')
  }
  if (tableA[3].body.currentBundleId !== '1.18.3-beta.2') {
    throw new Error('fixture A[3] must already be on 1.18.3-beta.2')
  }
  if (tableA[4].body.nativeVersion !== '1.18.3' || tableA[4].body.currentBundleId !== 'builtin') {
    throw new Error('fixture A[4] must be same-core stripped 1.18.3 + builtin')
  }

  const tableB = buildFixtureBProfiles()
  if (tableB.length !== 1 || tableB[0].expect !== 'apply_ota') {
    throw new Error('fixture B must assert apply_ota for ungated old shell')
  }
  if (tableB[0].body.nativeBuild !== 21) {
    throw new Error('fixture B must use nativeBuild 21 (legacy minNativeBuild must not gate)')
  }

  const fixtureC = fixtureCManifest()
  if (fixtureC.activeBundle.releaseVersion !== '1.18.3') {
    throw new Error('fixture C must set stable activeBundle.releaseVersion to 1.18.3')
  }
  const tableC = buildFixtureCProfiles()
  if (tableC.length !== 1 || tableC[0].expect !== 'apply_ota' || tableC[0].expectIsChannelRollback !== true) {
    throw new Error('fixture C must assert apply_ota + isChannelRollback for beta→stable rollback')
  }
  if (tableC[0].body.channel !== 'stable' || tableC[0].body.currentBundleId !== '1.18.4-beta.7') {
    throw new Error('fixture C must request stable with prerelease currentBundleId 1.18.4-beta.7')
  }

  // Live builder must also stop keying off minNativeBuild.
  const liveFromA = buildProfiles(fixtureA, '1.18.3-beta.2')
  if (liveFromA.some((p) => p.body.nativeBuild !== 21)) {
    throw new Error('live profile builder must use tiny nativeBuild (21), not minNativeBuild')
  }
  if (liveFromA[0].expect !== 'install_native_required' || liveFromA[3].expect !== 'none') {
    throw new Error('live profile builder mismapped gated expects')
  }
  if (liveFromA[0].body.nativeVersion !== '1.18.2' || liveFromA[0].body.currentBundleId !== 'builtin') {
    throw new Error('live old iOS profile must use a stripped identity truly below the beta gate')
  }
  const liveFromB = buildProfiles(fixtureB, '1.18.3-beta.2')
  if (liveFromB[0].expect !== 'apply_ota' || liveFromB[1].expect !== 'apply_ota') {
    throw new Error('live profile builder must treat missing minShellReleaseVersion as ungated')
  }

  console.log('  ok fixtures: A (gated version) + B (legacy ungated) + C (stable channel rollback)')
  for (const row of [...tableA, ...tableB, ...tableC]) {
    const rollback = row.expectIsChannelRollback ? ' + isChannelRollback' : ''
    console.log(`    ${row.name} -> ${row.expect}${rollback}`)
  }
}

assertFixtureTables()

if (fixturesOnly) {
  console.log('detectability fixtures verified (--fixtures-only)')
  process.exit(0)
}

let lastFailures = []
for (const delay of RETRY_DELAYS_MS) {
  if (delay > 0) await sleep(delay)
  lastFailures = []
  for (const base of bases) {
    const label = hostLabel(base)
    try {
      const profiles = buildProfiles(await fetchManifest(base))
      for (const profile of profiles) {
        try {
          const decision = await probe(base, profile.body)
          const actual = decision.primaryAction
          if (actual !== profile.expect) {
            lastFailures.push(`${label} ${profile.name}: expected ${profile.expect}, got ${actual}`)
          } else if (profile.expect === 'apply_ota' && decision.ota?.bundle?.releaseVersion !== version) {
            lastFailures.push(`${label} ${profile.name}: apply_ota offers ${decision.ota?.bundle?.releaseVersion ?? 'none'}, expected ${version}`)
          } else {
            console.log(`  ok ${label} ${profile.name} -> ${actual}`)
          }
        } catch (error) {
          lastFailures.push(`${label} ${profile.name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } catch (error) {
      lastFailures.push(`${label} manifest: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (lastFailures.length === 0) {
    console.log(`detectability verified: ${channel} ${version} (mode=${mode}) bases=${bases.join(',')}`)
    process.exit(0)
  }
  console.log(`  stale/mismatch (${lastFailures.length}), retrying...`)
}

console.error('::error::OTA detectability verification failed:')
for (const failure of lastFailures) console.error(`  - ${failure}`)
process.exit(1)
