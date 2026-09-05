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
[role="button"],
[data-slot="button"] {
  min-height: 36px;
  min-width: 36px;
}
```

`[data-slot="button"]` covers shared `Button asChild` anchors so link-styled
actions keep the same 36px floor as native `<button>` siblings.

Also note nearby spacing overrides such as `.py-2` padding inflation under the same gate.

Dense UI that intentionally uses sub-36px controls **must opt out**. Tailwind `h-6` / `w-3` alone does **not** win against this min size: the button still expands, gaps look huge, and row height jumps.

### Existing opt-outs (copy this pattern)

| Surface | Selector | File |
|---|---|---|
| Tool expandable rows | `.oc-tool-row[role="button"]` | `mobile.css` |
| Composer footer mobile actions | `.composer-mobile-actions button` | `mobile.css` |
| Composer send + stop controls | `button[data-composer-send="true"]` / `button[data-composer-stop="true"]` | `mobile.css` |
| Composer agent + model chips | `.composer-mobile-model-controls button` (locked to 26px so the revealed agent name stays vertically centered with the model chip) | `mobile.css` |
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

Shared classes (`.oc-mobile-floating-surface`, `.oc-mobile-glass-control`, dock, `.oc-composer-autocomplete-surface`, etc.) use translucent fills plus `backdrop-filter` on **all** mobile shells, including Capacitor Android. Do **not** reintroduce an Android-only “opaque fill + no blur” blanket; that is a full-platform downgrade, not progressive enhancement. Composer `/` `@` `#` catalogs on web/Android mobile reuse overlay glass blur inside a `fixed inset-0` host (`ComposerAutocompleteLayer`), but `.oc-composer-autocomplete-surface` drops the fill to a 22% elevated mix so the frost can read through. iOS WebKit cannot backdrop-filter the transcript from an `absolute` child of the composer card. Rows still use `.oc-composer-autocomplete-row:active` press fill — not a persisted selected slab.

Legitimate glass fallbacks:

| Gate | Behavior |
|---|---|
| `@media (prefers-reduced-transparency: reduce)` | Opaque elevated fill, `backdrop-filter: none` |
| Unsupported WebView / no filter | Browser ignores `backdrop-filter`; translucent fill + shadow still read as elevation |
| Settings detail canvas | `.oc-mobile-settings-detail-card` stays transparent (group cards own material) |

Android System WebView should be Chromium **111+** for `color-mix()` and reliable translucency (`packages/mobile/HANDOFF.md`).

Phone conversation headers (session chat and Assistant) share `--oc-mobile-header-fade` for the overlay/collapsing gradient (`color-mix` of `--surface-background` at 85%). Change that token when the fade strength should shift; do not restyle one surface with a local mix.

## Layout chrome dividers

Desktop shell edges (left/right sidebars, header/content split, context panel) use one token pair in `design-system.css`:

| Token / class | Role |
|---|---|
| `--layout-chrome-divider-width` | Hairline width (`0.5px`) |
| `--layout-chrome-divider` | `color-mix` of `--border` at 30% |
| `.oc-layout-divider-{t,r,b,l}` | Side-specific border using those tokens |

Do not reintroduce ad-hoc `border-border/40` / `border-border/50` on layout chrome; change the tokens when the whole family should shift.

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

The main chat and hydrating branches attach `.oc-chat-composer-swap-scope` and an overlay Composer foot only while React `isMobile` is true. Draft, empty, history-error, desktop, and disabled surfaces keep the in-flow expanded Composer. In-flow feet pin `--oc-mobile-composer-swap: 0` and hide `.oc-mobile-composer-compact-layer`, because opening a new chat from a session reuses ChatContainer's root node and can leak the session's inline compact swap onto the draft page — the pill then paints "Tap to type" with `pointer-events: none` and the real textarea is gone. Native iOS in-flow feet add `padding-bottom: calc(var(--oc-native-composer-height) - 8px)` so project / branch stay above the pill (overlay pages already reserve that hole via absolute docking). The hook also `clearComposerSwap`s the previous scope when it unmounts or detaches. The Hook publishes `--oc-mobile-composer-swap` plus phase and rest attributes: upward scroll starts tracking immediately (~40px → follow half that only exits the expanded card); finishing ≥0.5 auto-snaps so the compact pill rises, otherwise idle snaps back over 240ms. A brief post-compact settle suppresses return-follow for momentum only; it is not a permanent latch, and snaps are interruptible so repeat cycles keep working. The complete card and queue / changes / todos descend as one expanded layer while an independent 80% glass preview rises from below; the real textarea remains in the expanded layer. Layers are staggered so progress 0.5 never paints both at once. The fixed `--oc-chat-foot-inset: calc(8rem + safe-area)` preserves transcript geometry, and motion uses transforms and opacity without JavaScript measurement or padding mutation. Capacitor iOS primary chat can replace the web textarea/pill with `OpenChamberComposer` (process-owned: conceal immediately on leave, teardown after the remount window, do not rebuild across phone-page remounts); `:root.oc-native-ios-composer` hides those layers and the web scroll-to-bottom controls, keeps swap tracking for fade-only motion, and retargets `--oc-chat-foot-inset` at collapsed `--oc-native-composer-height` plus `--oc-native-composer-accessory` without writing `--oc-chat-foot-inset` from JS. **Both foot-inset declarations live on the root and differ only by `.oc-native-ios-composer`.** The web default used to be scope-qualified (`:root.mobile-pointer:not(.desktop-runtime) .oc-chat-composer-swap-scope`, 0-4-0) while the native override is a plain root-class selector (0-3-0), so the default out-specified it and native iOS silently kept the 8rem web reservation — the transcript reserved less than the pill plus its queued-message accessory actually occupied, and the newest message sat under the queue card. A root declaration also means no consumer resolves an undefined inset when React `isMobile` disagrees with `mobile-pointer`. `mobileComposerOverflow.test.ts` resolves the property through `getComputedStyle` on both class shapes rather than asserting selector text, so a re-qualified selector fails on the value it produces. Changes / TODO / queue stay absolutely docked to the overlay just above the pill (8px settle toward the pill) and fade with `--oc-native-composer-dock` (distance from the live edge; default hidden until published; approaching stays hidden until the true bottom). The queue card hides `data-oc-queue-composer-overlap` and uses matching vertical padding because the native pill no longer covers that tail. Swap rest is not the fade source: a downward reveal can expand the composer hundreds of px from the bottom, and those rows have no background veil. Native scroll-to-bottom stays on the overlay, appears after ~80px of upward travel, and is excluded from published occupancy. Native height is the collapsed pill occupancy (not the keyboard-raised frame) so CSS must not add safe-area again. Keyboard hide still clears leftover `--oc-kb-layout` / `oc-keyboard-open` even while composer FLIP is skipped. A tap on the compact preview restores expansion and focuses the textarea. The compact layer reuses the mobile glass control recipe (`--oc-mobile-glass-fill`, `--oc-mobile-glass-shadow` with its top inset highlight, and glass blur/saturate) shared with the bottom Tab dock and settings search field. Focus, dictation, and native keyboard pin expansion; reduced motion makes snapping immediate, and reduced transparency keeps an opaque elevated fill while preserving the glass shadow.

## Design pt (`--dpt`)

`--dpt` is `1px` everywhere except Capacitor native shells, where
`packages/ui/src/lib/designPtScale.ts` overwrites it.

- iOS: `10/9`.
- Android: physical `xdpi/ydpi` so `1dpt ≈ 1/163in`, then × `0.95/0.9`
  and cap at `0.95`. Typical math already sits at ~0.9, so a cap-only
  change stays 0.9; the multiply is what actually moves those phones.
  A bare `1` or iOS `10/9` is too large because WebView CSS px is 1 dp.

Cache key `openchamber.designPtScale.v7` drops v6 (`0.9`).

`scripts/postcss-dpt-font-size.mjs` rewrites compiled `font-size`,
`line-height`, and `--text-*` px/rem values to `calc(N * var(--dpt))`.
It does not touch `1px` hairlines, media queries, safe-area, or keyboard
insets. Layout spacing stays CSS px/rem.

Tailwind `text-xs` … `text-9xl` are owned in `@theme inline`
(`design-system.css`) as `calc(N * var(--dpt))`, same pattern as the
spacing scale and `--padding-scale`. Arbitrary `text-[13px]` still
depends on the PostCSS `font-size` rewrite.

The composer highlight overlay (`[data-composer-highlight="true"]`) must
use the same `calc(16 * var(--dpt))` as the textarea. Attachment chips
turn the overlay on (textarea becomes `text-transparent`); a fixed-px
overlay against a `--dpt`-scaled field looks like the font suddenly grew
and puts the caret in the wrong place.

## HTML file preview edge-to-edge

Sheet surfaces reserve bottom safe padding by default (`MobileWindowMotionRecipe` + Capacitor `.pwa-overlay-panel`). HTML preview must paint to the physical bottom without a child negative margin (overflow-hidden body clips it into a light band).

| Marker | Owner | Effect |
|---|---|---|
| `data-mobile-html-preview="true"` | `MobileFilesSurface` sheet HTML viewer (preview mode only) | Active non-inert `[data-oc-motion-id]:has(...)` zeros `padding-bottom` |
| `data-mobile-html-fullscreen="true"` | Fullscreen HTML preview portal | Hides home-indicator `body::after` via `:has` |

`body::after` opacity uses structural `:has([data-mobile-overlay-active="true"]:not([inert]) [data-mobile-html-preview="true"])` and `:has([data-mobile-html-fullscreen="true"])` — not a root class toggle — so mode switches and multi-instance close restore automatically. Source mode keeps the default safe pad.

## Related owners

- Detection / root classes: `packages/ui/src/lib/device.ts`
- Design pt scale: `packages/ui/src/lib/designPtScale.ts`
- Touch CSS: `packages/ui/src/styles/mobile.css`
- Design-system components: `packages/ui/src/styles/design-system.css` (`.oc-segmented-selected-pill`)
- Queued message chip layout: `packages/ui/src/components/chat/QueuedMessageChips.tsx` (root class `oc-composer-queue`)
- Mobile shell early `isMobile`: `packages/ui/src/apps/renderMobileApp.tsx`
- HTML preview markers / sheet overscroll: `packages/ui/src/apps/MobileFilesSurface.tsx`, `packages/ui/src/components/ui/iframeSheetOverscroll.ts`
