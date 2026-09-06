# Lynx CI skeleton

`lynx-ci.yml` is the GitHub Actions workflow for the Lynx track.

**Install:** copy to `.github/workflows/lynx-ci.yml` (requires a token with the `workflow` scope). Until then this file is the source of truth in-tree.

**Jobs (Linux):**
- `packages/lynx` type-check (`tsc --noEmit`)
- vitest
- rspeedy build

**Not claimed here:** APK `assembleDebug` / iOS simulator — need Mac/Android runners. Do not tick 真机过 from this workflow.
