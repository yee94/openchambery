# Lynx runnable notes (Linux box)

Integrated branch work for making `@openchamber/lynx` typecheck/test/bundle on a Linux agent without Xcode.

## Toolchain (this environment)

| Tool | Version |
|---|---|
| bun | 1.3.14 |
| node | v24.20.0 |
| typescript | 5.9.3 (workspace) |
| vitest | 4.1.11 |
| @lynx-js/rspeedy | 0.17.1 |
| @lynx-js/react | 0.126.0 |
| @lynx-js/react-rsbuild-plugin | 0.20.1 |
| @lynx-js/types | 4.2.1 |

## Commands attempted

```sh
bun install
bun run --cwd packages/lynx type-check   # PASS (tsc --noEmit)
bun run --cwd packages/lynx test         # PASS — 17 files / 69 tests
bunx vitest run --project @openchamber/lynx  # PASS — same 69 tests
bun add --cwd packages/lynx -d @lynx-js/rspeedy@0.17.1 @lynx-js/react@0.126.0 @lynx-js/react-rsbuild-plugin@0.20.1 @lynx-js/types
bun run --cwd packages/lynx build:rspeedy  # PASS — wrote packages/lynx/dist/main.lynx.bundle (~87 kB)
```

`dist/` is gitignored (root `.gitignore`).

## Platform blockers for real screenshots

| Target | Status |
|---|---|
| iOS Simulator / IPA | **Blocked** — Linux box has no Xcode / `xcodebuild` / Simulator. Lynx Explorer iOS prebuilts require macOS + Simulator. |
| Android APK / Lynx Explorer | **Blocked here** — `ANDROID_HOME` unset; no `adb` / Android SDK / Gradle host project under `packages/lynx/host/android` (Kotlin sources are embedding stubs only, not an app module). |
| Lynx Explorer QR/dev | Bundle builds via Rspeedy; loading it still needs a Lynx Explorer (or host LynxView) on a device/simulator. |

## What “runnable” means on this branch

1. Package typecheck + Vitest green.
2. `lynx.config.ts` is a real Rspeedy `defineConfig` with `engineVersion: '3.8'`.
3. `build:rspeedy` produces `dist/main.lynx.bundle` on Linux Node/bun tools.

Native host SDK link (CocoaPods/Gradle Lynx Engine) and 真机 screenshots are still out of scope until a Mac + device/simulator path exists.
