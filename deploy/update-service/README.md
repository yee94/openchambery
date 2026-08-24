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
Windows, and Linux use Electron updater metadata under `/desktop/`. Those
metadata responses point signed package downloads at GitHub Release assets.

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
- `platform`: `ios` \| `android`
- `deviceId`: non-empty string (rollout bucketing)
- `nativeVersion`: native marketing version string
- `nativeBuild`: positive integer
- `shellApiVersion`: positive integer
- `currentBundleId`: active OTA bundle id, or `builtin`. On the beta channel this must be the running **web** bundle version, never the iOS marketing version (`1.18.2`). Capgo builtin reports `CFBundleShortVersionString`; the resolver ignores that stripped identity when it matches `nativeVersion`, otherwise every `1.18.2-beta.N` OTA looks like a downgrade. It is also the primary identity for the shell version gate (`minShellReleaseVersion`); beta clients must report the running web package version.
- `installSource`: optional string

### Decision response (`/v1/mobile/update/check`)

```json
{
  "status": "ok",
  "primaryAction": "none | apply_ota | install_native_required",
  "ota": { "state": "current | available | outside_rollout | incompatible", "bundle": { } },
  "native": { "state": "current | available | required", "version": "", "build": 0, "installUrl": "" },
  "nextCheckInSec": 3600,
  "releaseNotes": "optional markdown newer than currentBundleId (not stripped iOS nativeVersion) through OTA releaseVersion"
}
```

Clients must follow `primaryAction`: `apply_ota` applies the bundle in-app;
`install_native_required` opens `native.installUrl` when present; `none` hides
the update. Do not invent a GitHub URL on the client.

Relative `bundle.url` values are resolved to absolute URLs against the request origin.
When `primaryAction` is `apply_ota`, the handler loads `/CHANGELOG.md` from the same
origin and attaches filtered `releaseNotes` (same extraction as `/v1/update/check`).
Missing or empty changelog content omits the field.

### Capgo response (`/v1/ota/check`)

Maps the same resolver decision:

- `apply_ota` → `{ version, url, checksum, session_key?, sessionKey? }`（Android 解析 `sessionKey`，iOS 解析 `session_key`，加密 bundle 两个键都返回；明文 `checksum` 为纯 64 位 hex，原生插件按字面值比较）
- `install_native_required` → `{ major: true, breaking: true, message: "native update required" }`
- otherwise → `{ message: "No new version available", version: "", url: "" }`

OTA 只升不降：`currentBundleId` / 带 `-beta.N` 的 `nativeVersion` / 门身份已达到的 `nativeTargets.version` 任一高于 `activeBundle.releaseVersion` 时，不返回 `apply_ota`。同版本不同 `bundleId` 仍可作内容更正。原生壳下限用版本号 `activeBundle.minShellReleaseVersion`（`mode: native` 发布时写入本轮版本）；`platforms.*.minNativeBuild` 仅存量兼容，build 号不再参与任何判定。壳内嵌 web（Capgo `builtin`）必须把已烘焙的 `__APP_VERSION__` 当作 `currentBundleId` 上报；门身份（`currentBundleId` 或回退 `nativeVersion`）不低于 `activeBundle.releaseVersion` 时视为已内嵌，避免反复 `apply_ota`。

Manifest load failure returns `503 { "error": "ota_manifest_unavailable" }` on both endpoints (never a forged no-update).

Capgo clients typically send `platform`, `device_id`, `app_id`, `version_build`, `version_code`, `version_name`, and `defaultChannel`.

### Channel manifest

Static file: `ota/channels/<channel>.json` (seeds: `ota/channels/beta.json` and `ota/channels/stable.json`). Both beta and stable channels are served the same way.

Schema summary (`schemaVersion: 1`):

- `channel`, `generation`
- `activeBundle`: full bundle metadata, or `null` when OTA is enabled but nothing is published yet
  - `minShellReleaseVersion` (optional): semver `X.Y.Z` / `X.Y.Z-beta.N`；原生壳能力下限，低于此版本 → `install_native_required`
  - `platforms.ios|android.minNativeBuild` (**deprecated**): 存量 manifest 兼容读取；判定已不使用
- `nativeTargets.ios|android`: optional `{ version, build, status?, installUrl? }`
- `rollbackBundleIds`: 0–2 hex bundle ids

Build copies the entire `ota/` tree into `public/` (Vercel) or `dist/` (EdgeOne) and fails if either `ota/channels/beta.json` or `ota/channels/stable.json` is missing or invalid.

### Cache rules

| Path | Cache-Control |
| --- | --- |
| `/ota/bundles/(.*)` (full GET) | `public, max-age=31536000, immutable` |
| `/ota/bundles/(.*)` (client `Range` or upstream `206`) | `no-store` (never edge-cache partial bodies) |
| `/ota/channels/(.*)` | `no-cache, max-age=0` |

### Deploying bundles and channels

CI publishes a static snapshot: place zip artifacts under `ota/bundles/<bundleId>.zip` and update the matching `ota/channels/<channel>.json`. The Vercel origin (`openchamber-update.vercel.app`) is authoritative — CI deploys snapshots there via `vercel deploy --prebuilt`.

The EdgeOne host (`openchamber.xiaobe.top`) deploys from git and therefore only carries the seeds. To keep it current, `edge-functions/ota/[...path].js` reverse-proxies `/ota/channels/*.json` and `/ota/bundles/*.zip` to the Vercel origin with edge-friendly cache headers (channels `s-maxage=60` + stale-while-revalidate, full bundles `immutable`). For bundle paths only, the proxy forwards client `Range` and passes through `content-range` / `accept-ranges` so Capgo native resume works; channel paths never forward `Range`. Partial responses use `cache-control: no-store` so an edge never caches a byte-range body that would poison later full GETs. The proxy is path-allowlisted and surfaces upstream failures as `502` — it never fabricates an authoritative no-update.
