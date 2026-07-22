# OpenChamber Update Service

This EdgeOne Makers project serves the public OpenChamber update-check API at
`POST /v1/update/check`.

## Contract

The endpoint accepts the existing client payload. It derives its decision from
`currentVersion` and returns `latestVersion`, `updateAvailable`,
`releaseNotes`, `releaseNotesUrl`, platform download targets, and
`nextSuggestedCheckInSec`.

The service reads only `currentVersion`. It ignores `installId` and retains no
request data.

## Build inputs

`bun run build` creates the deployable `dist/` directory from repository-owned
release sources:

- `release-manifest.json` provides the latest published version.
- `CHANGELOG.md` provides release notes.
- `dist/update-manifest.json` and `dist/CHANGELOG.md` are consumed by the Edge
  Function at request time.

The release workflow updates `release-manifest.json` after GitHub publishes a
release. Every following EdgeOne deployment serves that published version.
GitHub Actions needs repository `contents: write` permission for this manifest
commit.

## EdgeOne Makers setup

Create a separate Makers project with these values:

| Setting | Value |
| --- | --- |
| Project name | `openchamber-update` |
| Production branch | `main` |
| Preset framework | `Other` or `Static` |
| Root directory | `deploy/update-service` |
| Build command | `bun run build` |
| Install command | `bun install` |
| Build output directory | `dist` |

Makers assigns a project domain after the first successful deployment. Use that
domain for the first API verification. A custom domain can later provide
mainland delivery through domain verification, ICP filing, and an acceleration
region that includes MLC.

Connect the repository to Makers so pushes to `main` create production
deployments.

OpenChamber Web, CLI, VS Code, Capacitor mobile, and macOS Desktop use
`https://openchamber-update.edgeone.dev/v1/update/check`. Windows and Linux
Desktop use the Electron updater metadata under `/desktop/`. Those metadata
responses point signed package downloads at GitHub Release assets.

`OPENCHAMBER_UPDATE_API_URL` remains available as a compatible JSON API
override for Web, VS Code, and macOS Desktop.
