# OpenChamber Update Service

This Vercel project serves the public OpenChamber update-check API at
`POST /v1/update/check`.

## Contract

The endpoint accepts the existing client payload. It derives its decision from
`currentVersion` and returns `latestVersion`, `updateAvailable`,
`releaseNotes`, `releaseNotesUrl`, platform download targets, and
`nextSuggestedCheckInSec`.

The service reads only `currentVersion`. It ignores `installId` and retains no
request data.

## Build inputs

`bun run build` creates the deployable `public/` directory from repository-owned
release sources:

- `release-manifest.json` provides the latest published version.
- `CHANGELOG.md` provides release notes.
- `public/update-manifest.json` and `public/CHANGELOG.md` are consumed by the
  Edge Function at request time.

The release workflow updates `release-manifest.json` after GitHub publishes a
**stable** release. Semver prereleases (`X.Y.Z-beta.N`, any version containing
`-`) must never be written into this manifest: `write-release-manifest.mjs`
skips them, and `release.yml` finalize-release skips the publish step for
prereleases. Desktop `/desktop/latest*.yml` likewise proxies GitHub
`/releases/latest`, which excludes prereleases. Every following Vercel
deployment serves that published stable version. GitHub Actions needs
repository `contents: write` permission for this manifest commit.

## Vercel setup

| Setting | Value |
| --- | --- |
| Project name | `openchamber-update` |
| Root directory | `deploy/update-service` |
| Build command | `node scripts/build.mjs` |
| Install command | none (no package dependencies) |
| Output directory | `public` |
| Framework preset | Other |

Connect the repository so pushes to `main` create production deployments, or
deploy with the Vercel CLI from `deploy/update-service`.

OpenChamber Web, CLI, and VS Code use
`https://openchamber-update.vercel.app/v1/update/check` through the connected
OpenChamber Server (with optional `OPENCHAMBER_UPDATE_API_URL` override). Capacitor
mobile clients call the public update API **directly** from the app process,
preferring EdgeOne (`https://openchamber.xiaobe.top/v1/update/check`), then
this Vercel endpoint, then GitHub Releases. Packaged Desktop builds on macOS,
Windows, and Linux use the shared OTA decision endpoint below. `/desktop/`
remains a legacy metadata proxy; new release CI no longer publishes YAML feeds.

`OPENCHAMBER_UPDATE_API_URL` remains available as a compatible JSON API
override for Web, VS Code, and server-side package update checks.

## Tests

```sh
bunx vitest run --project @openchamber/update-service
```

Or `bun run test` from this directory.

## EdgeOne transition compatibility

`edgeone.json` and `edge-functions/` keep the retired
`openchamber-update.edgeone.dev` feed available for already-installed clients.
Its build command writes `dist/`, while Vercel continues to build `public/`.
The EdgeOne project must permit public requests to its project domain; this
transition feed uses the same stable release manifest and GitHub release assets
as Vercel.

## Mobile OTA endpoints

Self-hosted Capgo-style OTA for Capacitor mobile clients.

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/mobile/update/check` | OpenChamber decision JSON |
| `POST` | `/v1/ota/check` | Capgo self-hosted protocol response |

Both accept CORS preflight (`OPTIONS`) and return `cache-control: no-store`.

### Request body (`/v1/mobile/update/check`)

Required JSON fields:

- `channel`: `beta` \| `stable`
- `platform`: `ios` \| `android` \| `desktop`
- `deviceId`: non-empty string (rollout bucketing)
- `nativeVersion`: native marketing version string
- `nativeBuild`: positive integer
- `shellApiVersion`: positive integer
- `currentBundleId`: active OTA bundle id, or `builtin`. On the beta channel this must be the running **web** bundle version, never the iOS marketing version (`1.18.2`). Capgo builtin reports `CFBundleShortVersionString`; the resolver ignores that stripped identity when it matches `nativeVersion`, otherwise every `1.18.2-beta.N` OTA looks like a downgrade. It is also the primary identity for the shell version gate (`minShellReleaseVersion`); beta clients must report the running web package version.
- `installSource`: optional string
- `releaseMajor`: optional non-negative integer (`X` in `X.Y.Z`), explicitly sent by new clients. It must agree with the first parseable identity in `currentBundleId`, then `nativeVersion`. Legacy clients and Capgo requests may omit it; the server derives the same value from those existing fields. A builtin/hash bundle id falls back to the native marketing version; stripping a beta suffix does not change its major.

### Major-version isolation

OTA selection is scoped by **release major × channel**. A 1.x client receives only 1.x bundles on either stable or beta, and a 2.x client receives only 2.x bundles. Beta→stable rollback is permitted only within that major. The running web release identity takes precedence over the native marketing version. An unknown identity or an unpublished major yields `none` without an OTA or native target; it never falls back to another major. Fetch/validation failures still return 503.

New clients also validate the response major and reject mismatched bundles before downloading or reusing cached bundles. This protects them against older update-service deployments that ignore `releaseMajor`. Native Capgo automatic checks use the server-side inferred major. Desktop uses the same resolver with its own artifact and shell gate; Web, hosted mobile and VS Code do not use this OTA path.

Rollout order: deploy this update-service implementation to **both Vercel and EdgeOne before publishing a second major**, then publish using the updated snapshot scripts. Existing clients need no request migration. All subsequent publishing/rollout jobs (including maintenance releases from a 1.x branch) must use the major-aware scripts; older writers drop the catalog. Reverting the service or publishing scripts to a pre-isolation version is not compatible with a multi-major catalog.

### Decision response (`/v1/mobile/update/check`)

```json
{
  "status": "ok",
  "primaryAction": "none | apply_ota | install_native_required",
  "ota": { "state": "current | available | outside_rollout | incompatible", "bundle": { } },
  "native": { "state": "current | available | required", "version": "", "build": 0, "installUrl": "" },
  "nextCheckInSec": 3600,
  "releaseNotes": "optional markdown newer than currentBundleId (not stripped iOS nativeVersion) through OTA releaseVersion or native.version",
  "isChannelRollback": "optional true only for cross-channel beta→stable rollback apply_ota"
}
```

Clients must follow `primaryAction`: `apply_ota` applies the bundle in-app;
`install_native_required` opens `native.installUrl` when present; `none` hides
the update. Do not invent a GitHub URL on the client.

Relative `bundle.url` values are resolved to absolute URLs against the request origin.
When `primaryAction` is `apply_ota` or `install_native_required`, the handler loads
`/CHANGELOG.md` from the same origin as the channel manifest and attaches filtered
`releaseNotes` (same extraction as `/v1/update/check`). The upper bound is the OTA
`releaseVersion` for in-app apply, or `native.version` when the shell must reinstall.
On EdgeOne that origin is the Vercel host — same-origin CHANGELOG is either a
reverse-proxied fetch loop or a git-time static file that stops before the current
OTA range, which omits `releaseNotes`. Missing or empty changelog content omits the
field.

`isChannelRollback` is present (and `true`) only when all of the following hold:
request `channel` is `stable`, device `currentBundleId` is a prerelease (contains `-`,
e.g. `1.18.4-beta.7`) whose semver ranks above the stable `activeBundle.releaseVersion`,
and the decision is `apply_ota` (intentional cross-channel rollback onto that stable
active). All other responses omit the field. Clients use the flag to treat the apply
as a channel switch rather than a normal upgrade.

### Capgo response (`/v1/ota/check`)

Maps the same resolver decision:

- `apply_ota` → `{ version, url, checksum, session_key?, sessionKey?, is_channel_rollback? }`（Android 解析 `sessionKey`，iOS 解析 `session_key`，加密 bundle 两个键都返回；明文 `checksum` 为纯 64 位 hex，原生插件按字面值比较；跨渠道回退时额外带 `is_channel_rollback: true`）
- `install_native_required` → `{ major: true, breaking: true, message: "native update required" }`
- otherwise → `{ message: "No new version available", version: "", url: "" }`

OTA 只升不降：`currentBundleId` / 带 `-beta.N` 的 `nativeVersion` / 门身份已达到的 `nativeTargets.version` 任一高于 `activeBundle.releaseVersion` 时，不返回 `apply_ota`。例外：请求 `stable` 且设备 `currentBundleId` 为更高的 prerelease 时，允许 `apply_ota` 回退到 stable active，并标记 `isChannelRollback` / Capgo `is_channel_rollback`。同版本不同 `bundleId` 仍可作内容更正。原生壳下限用版本号 `activeBundle.minShellReleaseVersion`（`mode: native` 发布时写入本轮版本）；比较沿用 semver，同 core 的 stripped stable（如 `1.18.3` / `1.19.0`）高于任何同 core prerelease 门（`1.18.3-beta.1` / `1.19.0-beta.37`），因此该身份过门并 `apply_ota`。detectability verifier 的 live old iOS 画像使用语义上真实低于 gate 的 stripped 身份（`versionBelow(stripPrerelease(gate))` 再 strip）；`stripPrerelease(versionBelow(gate))` 对 beta 门会塌成同 core stable。`platforms.*.minNativeBuild` 仅存量兼容，build 号不再参与任何判定。壳内嵌 web（Capgo `builtin`）必须把已烘焙的 `__APP_VERSION__` 当作 `currentBundleId` 上报；仅当 active 为 **stable**（非 prerelease）且门身份（`currentBundleId` 或回退 `nativeVersion`）不低于 `activeBundle.releaseVersion` 时视为已内嵌。beta active 时 iOS 剥离营销版号（如 `1.18.4`）不能证明内嵌了 `1.18.4-beta.N`，不得走 embedded → 仍 `apply_ota`。

Manifest load failure returns `503 { "error": "ota_manifest_unavailable" }` on both endpoints (never a forged no-update).

Capgo clients typically send `platform`, `device_id`, `app_id`, `version_build`, `version_code`, `version_name`, and `defaultChannel`.

### Channel manifest

Static file: `ota/channels/<channel>.json` (seeds: `ota/channels/beta.json` and `ota/channels/stable.json`). Both beta and stable channels are served the same way.

Schema summary (`schemaVersion: 1`):

- `channel`, `generation`
- `activeBundle`: full bundle metadata, or `null` when OTA is enabled but nothing is published yet
  - `minShellReleaseVersion` (optional): semver `X.Y.Z` / `X.Y.Z-beta.N`；原生壳能力下限，低于此版本 → `install_native_required`。同 core stripped stable 高于 prerelease 门；verifier old-shell 使用真实低于 gate 的版本身份
  - `platforms.ios|android.minNativeBuild` (**deprecated**): 存量 manifest 兼容读取；判定已不使用
- `nativeTargets.ios|android`: optional `{ version, build, status?, installUrl? }`
- `rollbackBundleIds`: 0–2 hex bundle ids
- `activeBundle.desktop` (optional for legacy manifests): `{ bundleId, url, size, checksum, shellFingerprint, minShellReleaseVersion }`. The desktop ZIP has the desktop `index.html` and `desktop-ota.json`; mobile's existing bundle may remain Capgo-encrypted. Both artifacts share the parent release version, channel, rollout and generation. A legacy manifest without this field offers no desktop OTA.
- `nativeTargets.desktop`: installer release target when the desktop shell, dependencies or shell-shared backend modules are incompatible. Ordinary backend source updates ship with the desktop UI ZIP. The desktop gate compares `nativeVersion`, not `currentBundleId`; current UI identity still controls upgrade/rollback and major isolation.
- `rollbackBundles`: up to two full prior bundle records keyed by `rollbackBundleIds`. Snapshot/rollout mirrors their desktop ZIPs as well as mobile ZIPs. New rollbacks restore original versions, checksums, encryption metadata and shell floors; legacy rollback entries without desktop metadata cannot be used to reconstruct a desktop bundle.
- `majorReleases` (optional): map of other major numbers to complete schema-v1 channel manifests, with no nested `majorReleases`. The root remains the most recently published/modified lane for existing publishing consumers; the resolver selects by client major, never by the root's recency. Root and archived lanes must have distinct majors, the same channel, and same-major native targets/shell floors. Legacy manifests without the map remain readable. An empty legacy seed belongs to major 1.

`assemble-snapshot.mjs` selects previous state by the release's major, so generation, rollback ids, native targets and shell floors are independent per lane. It archives the previous root when switching majors and mirrors all lanes and their active/rollback zip files in both channels. `rollout.mjs --major X` targets a specific lane; omission retains the legacy default of the root lane. The rollout workflow exposes the same `major` input. Invalid catalogs or missing referenced bundles abort snapshot creation before deployment.

Build copies the entire `ota/` tree into `public/` (Vercel) or `dist/` (EdgeOne) and fails if either `ota/channels/beta.json` or `ota/channels/stable.json` is missing or invalid.

### Cache rules

| Path | Cache-Control |
| --- | --- |
| `/ota/bundles/(.*)` (full GET) | `public, max-age=31536000, immutable` |
| `/ota/bundles/(.*)` (client `Range` or upstream `206`) | `no-store` (never edge-cache partial bodies) |
| `/ota/channels/(.*)` | `no-cache, max-age=0` (Vercel static); EdgeOne proxy uses `s-maxage=60` + stale-while-revalidate |
| `/CHANGELOG.md` | Vercel static: `max-age=300`; EdgeOne proxy: same short TTL as channels (`s-maxage=60`) |

### Deploying bundles and channels

CI publishes a static snapshot: place zip artifacts under `ota/bundles/<bundleId>.zip` and update the matching `ota/channels/<channel>.json`. The Vercel origin (`openchamber-update.vercel.app`) is authoritative — CI deploys snapshots there via `vercel deploy --prebuilt`.

The EdgeOne host (`openchamber.xiaobe.top`) deploys from git and therefore only carries git-time seeds. To keep it current, EdgeOne reverse-proxies allowlisted paths to the Vercel origin:

- `edge-functions/ota/[[default]].js` → `/ota/channels/*.json` and `/ota/bundles/*.zip`
- `edge-functions/CHANGELOG.md.js` → exact `/CHANGELOG.md` (so mobile `releaseNotes` on EdgeOne match Vercel)

Cache headers: channels and CHANGELOG use `s-maxage=60` + stale-while-revalidate; full bundles use `immutable`. For bundle paths only, the proxy forwards client `Range` and passes through `content-range` / `accept-ranges` so Capgo native resume works; channel and CHANGELOG paths never forward `Range`. Partial responses use `cache-control: no-store` so an edge never caches a byte-range body that would poison later full GETs. The proxy is path-allowlisted and surfaces upstream failures as `502` — it never fabricates an authoritative empty body.

**Static assets shadow edge functions on EdgeOne**, so the EdgeOne build (`edgeone.json`) sets `OPENCHAMBER_UPDATE_SKIP_OTA_COPY=1` and `OPENCHAMBER_UPDATE_SKIP_CHANGELOG_COPY=1` — the `dist/` output must not contain `ota/` or `CHANGELOG.md`, or the proxies never run. Vercel still emits both as real static files (authoritative origin).
