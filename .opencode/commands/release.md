---
description: Publish an OpenChamber GitHub Release; usage: /release [version] [dry-run]
agent: build
---

You are releasing OpenChamber from this repository. Follow @docs/RELEASING.md and treat @.github/workflows/release.yml as the authoritative workflow contract.

Arguments: `$ARGUMENTS.opencode/commands/release.md`

Accept an optional semantic version in `X.Y.Z` or `X.Y.Z-prerelease.N` form, followed by an optional `dry-run` token. When no version is provided, read the highest version from the five release manifests and increment its patch component by one. Proceed automatically with that version.

Workflow:

1. Set `VERSION` from the argument or automatically calculate the next patch version. Inspect the worktree and recent release/tag state before making changes. Include all current worktree changes in the release commit.
2. Run `bun run version:bump -- "$VERSION"`.
3. Add the matching `## [$VERSION] - YYYY-MM-DD` section below `[Unreleased]` in @CHANGELOG.md. Draft user-facing release notes from the changes since the latest release tag and use the existing changelog style.
4. Stage all current changes, create commit `release: v$VERSION`, and create tag `v$VERSION`.
5. Push `main` and only tag `v$VERSION`. A tag push triggers the full desktop and Android Release workflow.
6. When `dry-run` was requested, dispatch the workflow manually instead of creating or pushing a tag:

   ```bash
   gh workflow run release.yml --repo yee94/openchamber --ref main -f version="$VERSION" -f dry_run=true
   ```

7. Do not monitor the Release workflow after triggering it.

Constraints:

- The current workflow accepts `version` and optional `dry_run`; it has no `release_scope` input.
- Never expose, print, or modify repository secrets or signing credentials.
- Execute the release flow without asking for confirmation during the command.
- Report the version, commit, tag, push result, and workflow dispatch result.
- If a previous attempt for the same version left a Draft Release, read @docs/RELEASING.md section `finalize-release` / asset inventory before re-dispatching. Prefer `gh run rerun <run-id> --failed` over starting a second same-version Release; stale `OpenChamber-$VERSION-$RUN_NUMBER-android.*` assets will block publish.
