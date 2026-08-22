---
description: Publish an OpenChamber GitHub Release; usage: /release [version] [dry-run]
agent: build
---

You are releasing OpenChamber from this repository. Follow @docs/RELEASING.md. Treat @.github/workflows/release.yml as the native-release contract and @.github/workflows/mobile-beta-ota.yml as the mobile web-bundle OTA contract. Beta / prerelease rules in @docs/RELEASING.md section `Beta / prerelease` are mandatory.

Arguments: `$ARGUMENTS.opencode/commands/release.md`

When the user asks to ship, update, or push a **beta**, classify the artifact first (`docs/RELEASING.md` § 先选产物). Do not default to a `v*` tag.

Accept an optional semantic version in `X.Y.Z` or `X.Y.Z-prerelease.N` form, followed by an optional `dry-run` token. When no version is provided: for an explicit beta request, increment the highest existing `X.Y.Z-beta.N` (must be newer than the live OTA `activeBundle.releaseVersion`); otherwise read the highest **stable** (`X.Y.Z`) version from the five release manifests and increment its patch component by one. Do not auto-increment into a `-beta` / prerelease unless the user explicitly asked for a beta or prerelease version.

Workflow:

1. Inspect the worktree and recent release/tag state. Run `node scripts/mobile-release-plan.mjs --json`. Choose the artifact:
   - `mode: "ota"` and the user only needs the installed mobile app updated → **OTA**: tag `mobile-beta/v$VERSION` (or `mobile-stable/v$VERSION`).
   - `mode: "native"`, or the user wants TestFlight / APK / desktop / npm → **native**: tag `v$VERSION`.
2. Set `VERSION` from the argument or the rule above. Include all current worktree changes in the release commit.
3. Classify the channel:
   - **Stable:** `X.Y.Z` with no `-` suffix.
   - **Beta / prerelease:** any semver with a `-` suffix (e.g. `1.16.94-beta.2`). Prefer `-beta.N` for intentional betas.
4. Run `bun run version:bump -- "$VERSION"`.
5. Add the matching `## [$VERSION] - YYYY-MM-DD` section below `[Unreleased]` in @CHANGELOG.md. Draft user-facing release notes from the changes since the latest release tag and use the existing changelog style.
6. Stage all current changes and commit:
   - OTA: `release: mobile-beta/v$VERSION` (or `mobile-stable/v$VERSION`), tag only that OTA tag.
   - Native: `release: v$VERSION`, tag `v$VERSION`.
7. Push `main` and only the tag from step 6. A `v*` tag triggers the full desktop and Android Release workflow. An OTA tag triggers Mobile OTA Release only.
8. When `dry-run` was requested, dispatch the workflow manually instead of creating or pushing a tag:

   ```bash
   gh workflow run release.yml --repo yee94/openchamber --ref main -f version="$VERSION" -f dry_run=true
   ```

8. Do not monitor the Release workflow after triggering it.

## Beta / prerelease hard rules

Stable packaged clients must never be offered a beta through auto-update. When releasing a version that contains `-` (beta/rc/…):

- **Must** use a semver prerelease form such as `X.Y.Z-beta.N`. Never ship a beta as a plain `X.Y.Z` tag.
- **Must** rely on `release.yml` marking the GitHub Release as `prerelease: true` so it does **not** become `/releases/latest`.
- **Must not** write, commit, or push `deploy/update-service/release-manifest.json` to the beta version. That file is the stable Vercel JSON update feed; `write-release-manifest.mjs` and finalize-release already skip prereleases — do not bypass them.
- **Must not** manually promote a beta to Latest (`gh release edit … --latest`) or clear its prerelease flag unless the user explicitly converts it into a stable release.
- **Must not** point desktop updater feeds, Discord “latest”, or Android “latest APK” at a beta. Desktop Vercel `/desktop/latest*.yml` proxies GitHub `/releases/latest`; Android also uses `/releases/latest`.
- **Must** leave `autoUpdater.allowPrerelease = false` alone unless the user explicitly requests prerelease auto-update.
- After pushing a beta tag, if a previous beta was accidentally published as Latest, immediately restore the newest stable release as Latest (`gh release edit vX.Y.Z --latest`) and confirm `release-manifest.json` / Vercel `latest-mac.yml` still show that stable version.
- Beta still uploads iOS to Internal TestFlight only. Strip the prerelease suffix for Apple marketing versions (`1.16.134-beta.10` → `1.16.134`); build number still increments. Do not attach beta builds to the existing external TestFlight group or submit Beta App Review.

Constraints:

- The current workflow accepts `version` and optional `dry_run`; it has no `release_scope` input.
- Never expose, print, or modify repository secrets or signing credentials.
- Execute the release flow without asking for confirmation during the command.
- Report the version, commit, tag, push result, workflow dispatch result, and whether the release is stable or prerelease.
- If a previous attempt for the same version left a Draft Release, read @docs/RELEASING.md section `finalize-release` / asset inventory before re-dispatching. Prefer `gh run rerun <run-id> --failed` over starting a second same-version Release; stale `OpenChamber-$VERSION-$RUN_NUMBER-android.*` assets will block publish.
