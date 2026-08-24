# Shared UI styles

Owning module for global CSS under `packages/ui/src/styles/`, including touch-mode adaptations in `mobile.css`.

## `isMobile` vs `mobile-pointer` (do not confuse)

OpenChamber has **two independent mobile signals**. Layout bugs that "look fine in DevTools inspect but wrong on device" almost always come from mixing them.

| Signal | Source | What it controls |
|---|---|---|
| `useUIStore.isMobile` / React `isMobile` branches | Layout shell, Capacitor `renderMobileApp` (`setIsMobile(true)`), width-based device type | React className branches (compact queue chips, mobile composer, sheets) |
| **`html.mobile-pointer`** | `packages/ui/src/lib/device.ts` → `getDeviceInfo()` / `setRootDeviceAttributes()` | **Global CSS** in `mobile.css` gated on `:root.mobile-pointer:not(.desktop-runtime)` |

`mobile-pointer` is set when any of these is true (and the runtime is not desktop shell / VS Code / `?surface=desktop`):

- `matchMedia('(pointer: coarse)')`
- `matchMedia('(hover: none)')`
- `navigator.maxTouchPoints > 0`

Capacitor forces `deviceType = 'mobile'` (so React `isMobile` stays true on tablets), but **`mobile-pointer` still follows real pointer capability**. Desktop Electron / VS Code add `desktop-runtime` and strip `mobile-pointer`.

### Symptom that means you hit this

- `isMobile === true` in both states.
- Spacing / button size looks **normal with DevTools inspect open**, then **abnormally large** when inspect closes (or the reverse on some emulators).
- Root cause: DevTools device mode / docking often flips `(pointer: coarse)` / `(hover: none)`, so `html` gains or loses `mobile-pointer` while React mobile branches stay on.

Quick check in the WebView console:

```js
document.documentElement.classList.contains('mobile-pointer')
matchMedia('(pointer: coarse)').matches
matchMedia('(hover: none)').matches
navigator.maxTouchPoints
```

## Global touch-target rule

Under `:root.mobile-pointer:not(.desktop-runtime)`, `mobile.css` raises generic interactive targets:

```css
button:not([role="radio"]):not([role="checkbox"]):not([role="switch"]),
.btn,
[role="button"] {
  min-height: 36px;
  min-width: 36px;
}
```

Also note nearby spacing overrides such as `.py-2` padding inflation under the same gate.

Dense UI that intentionally uses sub-36px controls **must opt out**. Tailwind `h-6` / `w-3` alone does **not** win against this min size: the button still expands, gaps look huge, and row height jumps.

### Existing opt-outs (copy this pattern)

| Surface | Selector | File |
|---|---|---|
| Tool expandable rows | `.oc-tool-row[role="button"]` | `mobile.css` |
| Composer footer mobile actions | `.composer-mobile-actions button` | `mobile.css` |
| Composer stop chip | `button[data-composer-stop="true"]` | `mobile.css` |
| Composer agent + model chips | `.composer-mobile-model-controls button` | `mobile.css` |
| Message action / footer icons | `[data-message-action-group="true"] button` | `mobile.css` |
| Composer queued-message chips | `.oc-composer-queue button` / `[role="button"]` | `mobile.css` |
| Composer attachment thumbs | `[data-attachment-preview="true"] button` | `mobile.css` |

Typical opt-out:

```css
:root.mobile-pointer:not(.desktop-runtime)
  .your-dense-surface
  button,
:root.mobile-pointer:not(.desktop-runtime)
  .your-dense-surface
  [role="button"] {
  min-height: 0 !important;
  min-width: 0 !important;
}
```

Then let the component own the real compact size via Tailwind (`h-7 w-3`, etc.).

### When adding a new dense control cluster

1. Prefer a stable surface class or `data-*` marker on the cluster root (for example `oc-composer-queue`).
2. Add an opt-out next to the other exceptions in `mobile.css` — do not only shrink utility classes on the button.
3. Validate with **`mobile-pointer` present** (real phone or DevTools coarse pointer). Inspect-only desktop pointer is not sufficient.
4. Do not remove the global 36px rule for ordinary primary actions; only exempt intentional dense clusters.

## Floating glass (mobile)

Shared classes (`.oc-mobile-floating-surface`, `.oc-mobile-glass-control`, dock, etc.) use translucent fills plus `backdrop-filter` on **all** mobile shells, including Capacitor Android. Do **not** reintroduce an Android-only “opaque fill + no blur” blanket; that is a full-platform downgrade, not progressive enhancement.

Legitimate glass fallbacks:

| Gate | Behavior |
|---|---|
| `@media (prefers-reduced-transparency: reduce)` | Opaque elevated fill, `backdrop-filter: none` |
| Unsupported WebView / no filter | Browser ignores `backdrop-filter`; translucent fill + shadow still read as elevation |
| Settings detail canvas | `.oc-mobile-settings-detail-card` stays transparent (group cards own material) |

Android System WebView should be Chromium **111+** for `color-mix()` and reliable translucency (`packages/mobile/HANDOFF.md`).

## Segmented selected pill

Shared class `.oc-segmented-selected-pill` in `design-system.css` owns light/dark chrome for selected segments on muted tracks (scheduled Tasks/History, filter chips, `SortableTabsStrip` active-pill). Do not reintroduce `bg-[var(--surface-elevated)] shadow-sm dark:shadow-none` for that pattern — dark themes often collapse elevated into muted, so selection tokens carry contrast.

Mobile phone tracks also share:

| Class | Role |
|---|---|
| `.oc-mobile-segmented-track` | Outer floating track — shared CSS vars for pad `0.25rem`, gap `0.25rem`, item height `2.5rem` |
| `.oc-mobile-segmented-group` | Flex group of items (filters) that shares track gap |
| `.oc-mobile-segmented-item` | Hit target — fixed item height, concentric radius, centered label, press scale |
| `.oc-mobile-segmented-action` | Trailing control (create +) sized to the same item height / radius |
| `.oc-segmented-selected-pill` | Selected fill + soft shadow (no border ring) |

Radius family (one source of truth):

- `--oc-mobile-segmented-track-radius` → `var(--oc-mobile-surface-radius)`
- `--oc-mobile-segmented-item-radius` → `track-radius − pad` (concentric inner corners)

Do not hardcode `rounded-[var(--oc-mobile-inset-radius)]` on segmented pills in TSX; let the track CSS vars own both outer and inner radii.

Track total height may differ when a trailing action is present; pad/gap/item height stay identical so selected pills center the same way.

## Composer clip shells vs the overflow-hidden rewrite

Under `mobile-pointer`, `mobile.css` rewrites generic `.overflow-hidden` to `overflow-y: auto` so ordinary page columns can pan. Composer clip shells are not page columns:

| Surface | Why it must stay `overflow: hidden` |
|---|---|
| `[data-composer-content="true"] .overflow-hidden` | Input column clipper |
| `[data-composer-input-shell="true"]` and its `.overflow-hidden` child | Highlight overlay + textarea host |
| `[data-attachment-preview="true"]` | 40px image chip above the composer; must not become a scrollport |

If those become scrollports, a short mention shows **two** scrollbars (parent + textarea) instead of growing the card. The expanded `.oc-mobile-composer-surface` uses `min-height: min-content`. Its motion viewport and reveal keep popup overflow available.

The main chat and hydrating branches attach `.oc-chat-composer-swap-scope` and an overlay Composer foot only while React `isMobile` is true. Draft, empty, history-error, desktop, and disabled surfaces keep the in-flow expanded Composer. The Hook publishes `--oc-mobile-composer-swap` plus phase and rest attributes: upward scroll starts tracking immediately (~40px → follow half that only exits the expanded card); finishing ≥0.5 auto-snaps so the compact pill rises, otherwise idle snaps back over 240ms. A brief post-compact settle suppresses return-follow for momentum only; it is not a permanent latch, and snaps are interruptible so repeat cycles keep working. The complete card and queue / changes / todos descend as one expanded layer while an independent 80% glass preview rises from below; the real textarea remains in the expanded layer. Layers are staggered so progress 0.5 never paints both at once. The fixed `--oc-chat-foot-inset: calc(8rem + safe-area)` preserves transcript geometry, and motion uses transforms and opacity without JavaScript measurement or padding mutation. A tap on the compact preview restores expansion and focuses the textarea. The compact layer reuses the mobile glass control recipe (`--oc-mobile-glass-fill`, `--oc-mobile-glass-shadow` with its top inset highlight, and glass blur/saturate) shared with the bottom Tab dock and settings search field. Focus, dictation, and native keyboard pin expansion; reduced motion makes snapping immediate, and reduced transparency keeps an opaque elevated fill while preserving the glass shadow.

## Design pt (`--dpt`)

`--dpt` is `1px` everywhere except Capacitor Android, where
`packages/ui/src/lib/designPtScale.ts` overwrites it from
`DisplayMetrics.xdpi/ydpi` so `1dpt ≈ 1/163in` (iPhone pt), then caps
Android at `0.9` as a visibility experiment. iOS stays `1`.

`scripts/postcss-dpt-font-size.mjs` rewrites compiled `font-size`,
`line-height`, and `--text-*` px/rem values to `calc(N * var(--dpt))`.
It does not touch `1px` hairlines, media queries, safe-area, or keyboard
insets. Layout spacing stays CSS px/rem.

Typography presets are owned as `calc(N * var(--dpt))` in the style set,
not left as rem for PostCSS to catch later:

- Tailwind `text-xs` … `text-9xl` and rem `leading-3` … `leading-10`
  in `@theme inline` (`design-system.css`)
- Semantic `--text-markdown` / `--text-ui-label` / … on `:root`, with
  mobile-pointer overrides in `mobile.css`
- Mobile title/meta tokens (`--oc-mobile-*-title-size`, settings
  section titles) and `--form-helper-font-size`

Arbitrary `text-[13px]` still depends on the PostCSS `font-size` rewrite.
Unitless `leading-tight` / `leading-normal` stay ratios.

The composer highlight overlay (`[data-composer-highlight="true"]`) must
use the same `calc(16 * var(--dpt))` as the textarea. Attachment chips
turn the overlay on (textarea becomes `text-transparent`); a 16px overlay
against a 14.4px field looks like the font suddenly grew and puts the
caret in the wrong place.

## Related owners

- Detection / root classes: `packages/ui/src/lib/device.ts`
- Design pt scale: `packages/ui/src/lib/designPtScale.ts`
- Touch CSS: `packages/ui/src/styles/mobile.css`
- Design-system components: `packages/ui/src/styles/design-system.css` (`.oc-segmented-selected-pill`)
- Queued message chip layout: `packages/ui/src/components/chat/QueuedMessageChips.tsx` (root class `oc-composer-queue`)
- Mobile shell early `isMobile`: `packages/ui/src/apps/renderMobileApp.tsx`
