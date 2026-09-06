# `@openchamber/lynx` module ownership

Lynx native phone shell for the `work/lynx-native` track.

## Owns

- Four-root dock IA and secondary-page stack (`src/shell/`)
- Host embedding decision and host ↔ page bridge (`src/host/`)
- Lynx 3.8 `<blur-view>` glass mapping and Android blur downgrade (`src/glass/`)
- Lynx-local catalog for dock / stub copy (`src/i18n/`)
- Mobile settings **slug list** (bodies stay stubs) (`src/settings/`)
- Native host embedding sources (`host/ios/`, `host/android/`)

## Does not own

- Connect / pairing / secure store (other track)
- Session-index Projects home
- Chat transcript (LegendList 1.19 — other track; TanStack 1.18 forbidden)
- Settings editors
- Push / FCM / Live Activity / share / Capgo
- Capacitor `packages/mobile` and shared React `packages/ui` runtimes

## Invariants

- Chat is never a tab. Secondary pages hide dock / host tab chrome.
- Mode B forbids a second Lynx dock and forbids full-page auto glass skin.
- Android glass is `blur-radius`, never cloned `UIGlassEffect` attributes.
- Failure is not in scope yet: this slice has no authoritative fetches.
- Native hosts never own the Lynx route stack.

## Tests

Vitest project `@openchamber/lynx` (`src/**/*.test.ts`). Navigation harness: `src/harness/navigationScenario.ts`.
