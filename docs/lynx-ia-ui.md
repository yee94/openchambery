# Lynx mobile rewrite — IA / UI

Independent track: **`work/lynx-native`**. Visual and information architecture for the Lynx client. Product IA comes from Capacitor `MobileApp` + official photos in `docs/references/`. Glass APIs come from **Lynx 3.8** `<blur-view>`, not from invented CSS.

Do not invent Flexoki/Finder/Capgo **products**. Flexoki is the default **theme id** pair. Capgo is Capacitor web-bundle OTA. Finder is desktop reveal only.

---

## Official mobile IA

Four root tabs, chat pushed. Sources: `packages/ui/src/mobile/mobileTabs.ts`, `mobileNavigation.ts`, `docs/references/mobile_projects.png`, `mobile_schedules.png`, `mobile_chat.png`.

```text
┌─────────────────────────────────┐
│  collapsing page title          │
│  search / +                     │
│                                 │
│  project / assistant /          │
│  schedule cards                 │
│                                 │
│                                 │
│     [项目] [助手] [定时] [设置]  │  ← dock (not a fifth Chat tab)
└─────────────────────────────────┘

        tap session / assistant
                 ↓

┌─────────────────────────────────┐
│  ←  title                       │  ← MobileDetailNavigation
│                                 │
│  transcript (LegendList)        │
│                                 │
│  queue / Changes (above foot)   │
│  composer pill / card           │
└─────────────────────────────────┘
```

Rules that screenshots and code agree on:

1. **Chat is not a tab.** It is `MobileSecondaryState.kind = 'chat' | 'draft'`.
2. Assistant catalog is a tab; the conversation is the same second-level page chrome as session chat (`packages/ui/src/components/assistants/DOCUMENTATION.md`).
3. Settings is a tab with search + grouped slugs (`MOBILE_SETTINGS_PAGE_SLUGS`). Drill-in is a push, not a modal, on phone.
4. Instances can open as a secondary page above Projects (`kind: 'instances'`).
5. Sessions / Files / Changes / MCP / Update are **sheets** (`MobileResizableSheet`), not tabs.
6. iPad is a different IA (sidebar + side panels + Settings half-sheet). Phone first.
7. Connection welcome is a full-screen gate **before** the dock. No PIN / Face ID in Cap — do not add one.

Official photo contrast vs a typical rewrite guess:

| Guess | Official |
|---|---|
| Chat in the dock | Chat pushed |
| Material `NavigationBar` as the only iOS chrome | Floating glass capsule on iOS 26; Web `MobileTabBar` otherwise |
| Solid opaque headers | Collapsing title; chat header is a translucent fade (`MobileDetailNavigation`) |
| Finder-style file tree as a tab | Files is a chat sheet |
| Nearby / Bonjour strip | Does not exist |
| Todo / notes rail | Removed in 1.19.2 |

Flutter goldens on `work/flutter-native` are **not** the IA source. If they disagree with `docs/references/mobile_*.png` or `packages/ui/src/mobile/*`, ignore them.

---

## Host embedding strategy (Tab / Nav)

Lynx 3.8 improved host embedding: `<page>` can size with `auto-width` / `auto-height`, report `layoutchange`, and reuse `LynxEngine` across views ([Lynx 3.8 notes](https://lynxjs.org/next/blog/lynx-3-8)). **Whether the Lynx page paints system-looking Tab/Nav depends entirely on how the host embeds it.**

Pick **one** mode before writing the dock. Write it in the host README when the skeleton lands.

### Mode A — Full-page Lynx (Lynx owns chrome)

```text
UIWindow
  └─ LynxView (full safe-area)
       ├─ page content
       └─ Lynx dock (<blur-view> glass on iOS 26)
```

- Lynx draws the four-tab dock and the collapsing header.
- Official glass (`<blur-view blur-effect="glass" | "glass-container">`) **may** skin the dock, composer pill, search chip.
- Auto-height of the page is the window. Safe-area and home indicator are Lynx’s problem.
- Host `UITabBarController` / Android `NavigationBar` must **not** also exist.

Use Mode A if the Lynx app is the entire product binary (same spirit as “native is always on” on the Flutter track).

### Mode B — Host system chrome (host owns Tab / Nav)

```text
UITabBarController / Android host nav     ← system liquid-glass / Material
  ├─ LynxView (Projects)
  ├─ LynxView (Assistant)
  ├─ LynxView (Scheduled)
  └─ LynxView (Settings)
Chat / Assistant conversation:
  push a full-screen LynxView (or hide the tab bar)
```

- Host paints Tab/Nav. On iOS 26 this is real `UITabBar` liquid glass (Cap already does this in `OpenChamberTabBar` — chrome-only controller, React/Lynx still owns the selected id).
- Lynx pages are **content**. They must not paint a second floating dock.
- `auto-height` is useful so the host can size the LynxView to the remaining content slot.
- Secondary pages **hide** the host tab bar (Cap: overlay `hide` when `#mobile-overlay-root` is active or a secondary page is showing).
- Composer may still be a host overlay (Cap iOS `OpenChamberComposer`) or a Lynx glass card inside the chat LynxView — pick one, not both.

Use Mode B if you want system Tab/Nav physics (selected liquid-lens, interactive dismiss) without reimplementing them.

### Mode C — Cap hybrid (do not copy)

Capacitor today: WebView paints `MobileTabBar`; optional iOS 26 native overlay when `openchamber.iosNativeUi` is on. That exists because the product is a WebView. Lynx does not need a “native UI” settings toggle. **Do not ship Mode C.**

### Decision gate

| Question | A | B |
|---|---|---|
| Who owns `setActiveTab`? | Lynx | Host emits `tabSelected`; Lynx/JS still changes the selected id (Cap pattern) |
| Full-page auto glass skin? | Yes | No |
| Android dock | Lynx blur-radius capsule | System / Material nav |
| Chat | Lynx push inside the same view | Host push or hide-tab + Lynx chat page |
| Risk | Reimplementing iOS 26 tab physics | Two `LynxView`s and engine reuse (`LynxViewGroup`) |

**Slice 1 lock (landed on `packages/lynx`):** Mode B on iOS 26 (host `UITabBarController`, Lynx content), Mode A-style Lynx capsule on older iOS and Android. Chat is always a push that hides the dock. Do not “try both” in one binary. Revisit only after 真机过.

Code: `packages/lynx/src/host/embedding.ts`. Host README: `packages/lynx/README.md` (decision is at the top). Native mirrors: `packages/lynx/host/ios/`, `packages/lynx/host/android/`.

Full-page auto skin of glass chrome is **allowed only in Mode A**. In Mode B it is an IA bug (double dock).

---

## Official glass (Lynx 3.8 `<blur-view>`)

Upstream: [Lynx `<blur-view>`](https://lynxjs.org/api/elements/built-in/blur-view). Types: `@lynx-js/types` `BlurViewProps`.

`<blur-view>` is **backdrop** blur (like `backdrop-filter`). To blur the element itself, use CSS `filter: blur` instead.

### iOS liquid glass (3.8)

| Attribute | Values | Maps to | Notes |
|---|---|---|---|
| `blur-effect` | `light` \| `extra-light` \| `dark` \| **`glass`** \| **`glass-container`** | `UIGlassEffect` / `UIGlassContainerEffect` | `glass`: one material. `glass-container`: merge several glass elements into one effect |
| `glass-style` | `regular` (default) \| `clear` | `UIGlassEffect.Style` | 3.8 |
| `glass-interactive` | `boolean` (default false) | interactive glass | 3.8; touch/highlight through the material |
| `glass-tint-color` | color (default transparent) | tint | 3.8 |
| `spacing` | number (default 0) | fusion distance | Elements closer than `spacing` **merge** inside a `glass-container` |

Cap iOS 26 already uses interactive `UIGlassEffect` with chrome in the effect `contentView` (`packages/mobile/README.md` § Native iOS Composer / Tab Bar). Lynx `glass` / `glass-interactive` is the supported way to get that material **inside** a Lynx tree. Do not wrap a Lynx page in a second UIKit glass view that covers the same pixels.

`glass-container` + `spacing` is the right tool for:

- Dock icons that should read as **one** fused capsule (system tab bar does this for you in Mode B)
- Composer pill actions that should merge when close, split when far
- Search chip + `+` if they sit on one glass strip

Do not put the transcript inside `glass-container`. Glass is chrome, not paper.

### Android / other

| Attribute | Platform | Use |
|---|---|---|
| `blur-radius` | Android, iOS, Harmony | Gaussian backdrop blur. This is **not** liquid glass |
| `blur-sampling` | Android | Downsample for perf (default 6) |
| `enable-auto-blur` | Android | Auto refresh (default true) |
| `android-capture-target` | Android 3.9 | Raw id of the Lynx view to capture; target needs `flatten={false}` |
| `experimental-update-blur-radius` | Android 3.4 | Internal buffer path |

Android降级 (see gap board): `blur-radius` + theme surface, never a fake `UIGlassEffect`. Reviewers comparing to `mobile_projects.png` should judge **IA and type**, not iOS material.

### Where glass belongs (Mode A)

| Surface | Treatment |
|---|---|
| Root dock | `glass` or host `UITabBar` (Mode B). Selected glyph uses theme `--primary` |
| Search chip / header buttons | Small `glass` chips; do not cream-fill |
| Composer collapsed pill / expanded card | **代码接上** via `LynxComposerGlassCard` → `GlassChrome` (`composerPill` / `composerCard`). iOS 26: `glass` + `glass-interactive`; older iOS theme blur; Android `blur-radius` only. Replaces elevated solid fill on Chat + Draft. **Not** 真机过. |
| Autocomplete list | **ABOVE** the glass composer card as a **sibling** overlay (card width, ~8pt gap) — **never** inside `UIGlassEffect.contentView` / composer `GlassChrome` children (`forbidInsideGlassContentView`). Cap burned: UILabel titles invisible under vibrancy + taps eaten. Lynx: `LynxComposerAutocompleteList` + optional per-row `searchChip` GlassChrome **in the sibling tree only**. Not occupancy. |
| Chat transcript | **No glass** |
| Settings list | **No glass** on rows |
| Sheets | System sheet first; optional glass grabber, not a glass page |

### Theme

Default ids that exist: `flexoki-light`, `flexoki-dark` (`packages/ui/src/lib/theme/themes/index.ts`). Lynx should consume the same semantic tokens (background, surface, primary, float shadow) rather than inventing a “Lynx theme”. Mapping CSS variables → Lynx themes is implementation work, not a new brand.

---

## Composer and IME (UI)

Cap iOS (when native UI is on):

- Collapsed: full-width glass pill (`+`, placeholder, Send/Stop)
- Expanded: glass card, footer order `+` · spacer · Agent · model · Send/Stop
- Occupancy CSS is the **collapsed** height only
- Return sends; IME marked text confirms composition and must not insert a newline / rewrite
- Scroll-to-bottom is a glass control above Send after ~80px travel; **not** part of occupancy

Lynx must keep that **behavior** (order, occupancy, IME). The WebView FLIP path is forbidden (`docs/lynx-pitfalls.md`).

Lynx wiring (**代码接上**, not 真机过): Attach / Send / Stop / Queue live **inside** `LynxComposerGlassCard` (`LynxComposerActionsInGlass` + `composerActionsLayout.ts`). Cap order: collapsed pill `+`·input·Send/Stop; expanded card `+`·spacer·Agent·model·Send/Stop (± Queue while working). Draft pill keeps Send (+ Attach stub) inside glass — no action row below the card.

Autocomplete / `/` `@` command list: sit **ABOVE** glass composer (sibling), never inside glass `contentView`. See `packages/lynx/src/chat/composerAutocompleteLayout.ts` + Cap `OpenChamberComposerAutocomplete.swift`. Composer surface: `LynxComposerGlassCard` (Chat + Draft) — Linux JS wiring only; host Mode B overlay / 真机 glass paint still residual.

Android: native/Lynx textarea + host IME inset. No `39dvh` guess.

---

## Chat list (UI implications of LegendList)

The list **is** the scroll view. There is no separately rendered live tail.

UI consequences:

- Header (load-older) and footer (status, tail spacer, composer inset) are **list slots**, so `maintainScrollAtEnd` sees footer growth.
- Do not wrap the list in a second scroller.
- Rows never recycle — tool expand / permission cards keep state.
- Cold open may stay invisible until seed markdown is ready (Cap `markdownPinReveal`); that is allowed.
- Mobile has a **button** to load older history. Do not infinite-scroll on bounce.

Forbidden UI: a pinned “live” overlay under a virtualized history (1.18).

---

## Settings IA

Phone: Settings tab → search → group list → push page → (split) push entity editor.

Groups and order: `SETTINGS_PAGE_GROUP_ORDER` / `SETTINGS_PAGE_ORDER` in `packages/ui/src/lib/settings/metadata.ts`. Instance switching is the **connection** group and sits first.

Do not add:

- A “Lynx lab” / “Native UI” toggle
- Shortcuts, remote-instances, global-config, skills.catalog (not on the mobile list)
- Voice as a decorative page

Visual contract: `packages/ui/src/components/sections/shared/SETTINGS_DESIGN_SPEC.md` and `.agents/skills/settings-ui-patterns/SKILL.md` when implementation starts.

---

## Motion and back

- Phone chat stack: two-page window, predecessor inert, edge / Predictive Back (`packages/mobile/README.md` § Native Back Navigation).
- Secondary enter can be instant (Cap: no push WAAPI) so chat does not flash a left-settle.
- Sheets dismiss vertically; they are not stack pages.
- Hosted H5 (if Lynx ever embeds in a browser) has no edge-swipe — out of scope for the native binary.

Lynx gesture arena vs host Predictive Back must have **one** owner. Two back gestures is a 真机残差 waiting to happen.

---

## Copy and locales

User-visible strings follow existing i18n keys (`mobile.tabs.*`, settings keys). Do not invent English-only Lynx labels. Load `locale-ui-patterns` when implementation starts.

Do not add “Nearby”, “AirDrop”, “Siri dictation”, “Finder”, or “Flexoki Studio” to the UI.

---

## Related

- `docs/lynx-feature-inventory.md` — slugs, tabs, plugins
- `docs/lynx-pitfalls.md` — 附近 ≠ Bonjour, no WebView keyboard, no invented brands
- `docs/lynx-gap-board.md` — Android降级 for glass
- `docs/lynx-acceptance.md` — embedding modes are an acceptance gate
