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

OpenChamber Web, CLI, VS Code, and Capacitor mobile use
`https://openchamber-update.vercel.app/v1/update/check`. Packaged Desktop
builds on macOS, Windows, and Linux use Electron updater metadata under
`/desktop/`. Those metadata responses point signed package downloads at GitHub
Release assets.

`OPENCHAMBER_UPDATE_API_URL` remains available as a compatible JSON API
override for Web, VS Code, and Capacitor mobile.

## EdgeOne transition compatibility

`edgeone.json` and `edge-functions/` keep the retired
`openchamber-update.edgeone.dev` feed available for already-installed clients.
Its build command writes `dist/`, while Vercel continues to build `public/`.
The EdgeOne project must permit public requests to its project domain; this
transition feed uses the same stable release manifest and GitHub release assets
as Vercel.
