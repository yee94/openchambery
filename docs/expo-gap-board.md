# Expo rewrite — living gap board

Status columns (use exactly these):

| Status | Meaning |
|---|---|
| **not started** | In inventory, no Expo code |
| **in progress** | Branch has a partial implementation |
| **landed** | Code complete on `work/expo-native` (CI/unit as applicable). **Not** 真机过 |
| **will-not-port** | Explicitly out of scope — see inventory |
| **真机过 residual** | Needs a physical device walk; automated green ≠ 真机过 |

Inventory (what “done” means): [`docs/expo-feature-inventory.md`](expo-feature-inventory.md).  
Acceptance (how we close a row): [`docs/expo-acceptance.md`](expo-acceptance.md).  
Pitfalls: [`docs/expo-pitfalls.md`](expo-pitfalls.md).

Do not mark 真机过 from a Linux VM.

## Seed (bootstrap 2026-09-06)

`main` @ `b444b0316` / `1.19.7-beta.7`. App path: `apps/mobile_expo`.

| Slice | Status | Notes |
|---|---|---|
| Branch `work/expo-native` from current `main` | landed | Independent; not merged |
| Gate docs (this set) | landed | Five docs + [`expo-native-README.md`](expo-native-README.md) |
| Capacitor `packages/mobile` left intact | landed | Constraint, not a port |
| Minimal Expo SDK scaffold + TypeScript | landed | Placeholder only |
| Four-tab shell (Projects / Assistant / Scheduled / Settings) | landed | Stub screens. No live APIs |
| Stub pushed Chat route | landed | Placeholder. No LegendList yet |
| Connection onboarding (URL / QR / password / pairing v2) | not started | Required. No local PIN |
| Relay-only skip 1.5s headstart | not started | Required. See pitfalls |
| Session index Projects home + `项目 · 分支` | not started | Required |
| Chat LegendList + Send/Stop | not started | LegendList contract, not 1.18 TanStack |
| Settings home + `MOBILE_SETTINGS_PAGE_SLUGS` | not started | Omit Voice |
| Native iOS chrome (`UIGlassEffect` / `UITabBar` / Live Activity) | not started | Always on; no `iosNativeUi` toggle |
| Android honest degrade | not started | No fake glass |
| Performance harness (LegendList long-context) | not started | Self-built; see 关3 |
| Prerelease debug APK (`applicationIdSuffix .debug`, label **OpenChamber Expo**) | not started | Side-by-side vs release Cap. Direct-link prerelease later |
| Signed release workflow | not started | Existing secret names only |
| CI lint / typecheck on `work/expo-native` | landed | `.github/workflows/expo-mobile-ci.yml`. Does **not** claim device builds |
| iOS Simulator / Android debug CI binaries | not started | Do not add jobs until they actually run |
| Capgo / EAS-as-ship-path | will-not-port | |
| `openchamber.iosNativeUi` toggle | will-not-port | |
| Chat dock tab | will-not-port | |
| Local PIN / Face ID lock | will-not-port | |
| Bonjour「附近」scanner | will-not-port | |
| Plan mode / project notes / Todo product | will-not-port | Removed 1.19.2 |
| Voice STT/TTS client | will-not-port | Same as Flutter |
| Live hosted OAuth / Local Network prompt / live `wss` phone | 真机过 residual | Even after code lands |

## How to update

1. Change a row’s status in this file in the same PR as the code.
2. Link the inventory row if the contract moved.
3. Never move a row to an implied sixth column (“looks fine on Simulator”). Simulator ≠ 真机过.
4. If a feature is dropped, move it to **will-not-port** and say why — do not delete history.

## Next slices (do not implement in the bootstrap)

Suggested order after this PR. Each slice should keep this board honest:

1. Connection onboarding + secure store + pairing v2 (including relay-only).
2. Session-index Projects home + four live tabs’ data.
3. Pushed Chat + LegendList + native composer occupancy contract.
4. Settings slug walk (no Voice, no `iosNativeUi`).
5. iOS native chrome modules (tab bar, composer glass, haptics, back).
6. Android degrade + debug APK CI + prerelease direct link.
7. Performance harness (关3) before claiming chat parity.
8. Share / push / Live Activity / widgets (device-gated).
