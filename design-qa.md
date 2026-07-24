# Mobile Settings Design QA

## Unified Settings workspace follow-up — 2026-07-24

### Visual inputs

- Scheduled-task settings language: `/var/folders/5l/tlc329r51b17td86h3klclbw0000gn/T/codex-clipboard-2465cb58-5377-4352-a05f-16aea0c7712f.png`
- Settings spacing defect: `/var/folders/5l/tlc329r51b17td86h3klclbw0000gn/T/codex-clipboard-dc1e233f-cc73-4b92-bd9f-41637e63d5ad.png`
- Settings hierarchy defect: `/var/folders/5l/tlc329r51b17td86h3klclbw0000gn/T/codex-clipboard-0350ebec-680c-4924-80b2-6368d9bb4cd2.png`
- Settings detail typography defect: `/var/folders/5l/tlc329r51b17td86h3klclbw0000gn/T/codex-clipboard-bd70eb6f-f4c4-4e04-8629-fd1f6f72cd12.png`
- Settings control-width defect: `/var/folders/5l/tlc329r51b17td86h3klclbw0000gn/T/codex-clipboard-f481ec84-b25b-40da-b3bf-d7112d307352.png`
- Settings divider defect after the first border pass: `/var/folders/5l/tlc329r51b17td86h3klclbw0000gn/T/codex-clipboard-99fdabde-f3ab-4860-86d3-6c4b1436ed07.png`

### Implemented contract

- PC and mobile share one Settings material vocabulary: group radius, group background, hairline border, row divider, row inset, and theme-aware inset shadow.
- Desktop Settings uses an explicit left-navigation/right-detail workspace. Navigation categories are quiet labels followed by grouped cards; detail sections use the same grouped material.
- Mobile keeps staged navigation, but its root groups and second-level detail sections consume the same tokens. Direct setting items receive consistent insets so checkboxes, descriptions, and controls cannot touch a card edge.
- Row labels and controls inherit the Settings base font-size and line-height instead of maintaining component-local type scales. Select, Input, and NumberInput use one control geometry token family; NumberInput exposes semantic slots so its stepper can participate in the same responsive width contract.
- Detail cards use the same semantic hairline border as the Settings root. Every non-final direct row owns one bottom divider. Conditional rendering uses fragments rather than layout wrappers, so dividers cannot disappear between independently gated rows.
- `SettingsPageLayout` now participates in the shared detail contract, covering plugin and remote-instance pages in addition to OpenChamber pages.
- Dark mode overrides card highlight with black only. Wide mobile viewports cannot inherit desktop rules because layout styling is scoped by the explicit desktop workspace class rather than a width media query.

### Validation

- Focused ESLint: passed.
- Mobile production build: passed. Existing KaTeX asset-resolution, circular re-export, and chunk-size warnings remain.
- Dead-code scan: completed earlier in this iteration; only the repository's existing generated-asset and unused reports were present.
- Runtime visual inspection of this follow-up reached the app passcode lock. No authentication state was bypassed, so the authenticated Settings interior was not re-captured in this pass.

follow-up result: implementation and static/build validation passed; authenticated visual re-capture pending unlock

## Comparison inputs

- Root issue reference: `/var/folders/5l/tlc329r51b17td86h3klclbw0000gn/T/codex-clipboard-99dedb9a-3221-4be4-9653-c0b9c8ea23e9.png`
- Detail design reference: `/var/folders/5l/tlc329r51b17td86h3klclbw0000gn/T/codex-clipboard-7cdc7b22-d0e6-49e4-b4c4-e48574b870ab.png`
- Verified root implementation: `/private/tmp/openchamber-settings-root.png`
- Verified detail implementation: `/private/tmp/openchamber-settings-detail.png`

## Result

PASS at a 426 × 923 mobile viewport.

- Settings root uses the full 390 px content width inside 18 px page gutters; the search control and every grouped card resolve to the same width.
- The root settings stage is transparent (`rgba(0, 0, 0, 0)`), removing the narrow tinted column from the issue reference.
- The document scroll width is 426 px, so the layout introduces no horizontal overflow.
- Section labels and grouped cards create the requested iOS-style settings hierarchy.
- Detail navigation works from the root. The detail card is also 390 px wide and aligned to the same 18 px gutter.
- The detail header is transparent and has a 0 px bottom border.
- The bottom tab dock remains fixed and visually separate from the scrolling page.

## Validation

- Focused ESLint: passed.
- Mobile production build: passed.
- Browser interaction: root → Appearance → back to root passed.

---

# Scheduled task compact navigation QA

## Comparison inputs

- Requested title location: `/var/folders/5l/tlc329r51b17td86h3klclbw0000gn/T/codex-clipboard-fcbf10ab-f64a-4146-b298-5f38c0b0b00f.png`
- Previous implementation: `/private/tmp/openchamber-scheduled-editor-nav-426x923.png`
- Verified implementation: `/private/tmp/openchamber-scheduled-editor-nav-refined-426x923.png`
- Side-by-side comparison: `/private/tmp/openchamber-scheduled-editor-nav-refined-comparison.png`
- Viewport: `426 × 923`, light Flexoki theme, edit-task state.

## Result

- The compact navigation title is centered independently of the leading control and reads “编辑计划任务”; create mode uses the existing localized “新建计划任务” title.
- P2 found in the previous implementation: a 10% foreground mix made the 48 px control read as a dirty gray disk, while the semibold title competed with the task name below.
- The refined back button is a 44 px `surface-elevated` circle with a 5% semantic hairline and a restrained two-stage shadow. The title now uses the smaller `typography-ui` scale with medium weight.
- The editable task name remains the first content heading below navigation, matching the requested two-level hierarchy.
- No new icon or raster asset was introduced; the existing sprite chevron is used at 20 px.
- No P0/P1/P2 issue remains in the side-by-side comparison.

final result: passed

---

# Unified mobile scheduled list and secondary navigation QA

## Comparison inputs

- Scheduled-list source: `/var/folders/5l/tlc329r51b17td86h3klclbw0000gn/T/codex-clipboard-9a097c20-4cfb-41ae-b64b-6d77c5b21ea7.png`
- Scheduled-list implementation: `/private/tmp/openchamber-scheduled-list-unified-426x923.png`
- Scheduled-list comparison: `/private/tmp/openchamber-scheduled-list-unified-comparison.png`
- Chat-header source: `/var/folders/5l/tlc329r51b17td86h3klclbw0000gn/T/codex-clipboard-56d4ce63-41b7-4f62-aa5d-17a6c288f3da.png`
- Chat-header implementation: `/private/tmp/openchamber-chat-detail-unified-426x923.png`
- Chat-header comparison: `/private/tmp/openchamber-chat-header-unified-comparison.png`
- Apple navigation reference: `/var/folders/5l/tlc329r51b17td86h3klclbw0000gn/T/codex-clipboard-f0836b01-34f7-49c5-a8eb-adbcf62ded05.png`
- Apple-inset implementation: `/private/tmp/openchamber-chat-header-apple-inset-426x923.png`
- Apple-inset side-by-side comparison: `/private/tmp/openchamber-apple-inset-comparison-426x923.png`
- Task-editor shadow report: `/var/folders/5l/tlc329r51b17td86h3klclbw0000gn/T/codex-clipboard-f595014c-766e-4ce7-9865-8f2d8b7dbe92.png`
- Task-editor implementation: `/private/tmp/openchamber-scheduled-editor-unified-426x923.png`

## Shared design contract

- The mobile Scheduled list no longer renders a search field. Its filter control and task cards share the Project tab's floating-surface material, 24px outer radius, spacing rhythm, 44px glass icon container, entity title/meta typography, and circular row action.
- Mobile task summaries omit the timezone while retaining the schedule and relative next-run time. The underlying schedule data and non-mobile presentation are unchanged.
- `MobileDetailNavigation` now owns secondary navigation for Settings, scheduled-task editing, session chat, and Assistant conversations. It fixes left and right actions to the same 40px circular geometry, gives both actions the same blurred glass material, centers a width-constrained title, and keeps the back action at one stable Apple-style 16px screen-edge inset.
- Session chat no longer displays the idle-state subtitle. The centered title truncates within the shared maximum width instead of competing with navigation actions.
- The scheduled-task name field explicitly removes the broad workspace input shadow and background so it reads as content below the shared navigation rather than as an accidental floating card.

## Browser verification

- Viewport `426 × 923`: Scheduled controls and task card both measure `366px` wide with a `24px` radius and the same floating-surface shadow. The leading project-style icon measures `44 × 44px`.
- Viewport `426 × 923`: the Settings detail page, scheduled-task editor, and session chat render the same header geometry. Visible chat actions measure `40 × 40px`, use a fully circular radius, and resolve `backdrop-filter` to `blur(16px) saturate(1.25)`.
- Viewport `426 × 923`: after removing the parent-specific padding override, the visible back action measures `x = 16px` in session chat and scheduled-task editing; chat's right action is the exact mirror at `x = 370px`. The normalized Apple reference places its circular back action at approximately the same 16px physical inset.
- The verified chat header contains no idle label. Its left back action and right overflow action remain symmetrically anchored while the title stays centered and truncated.
- The verified scheduled editor contains no shadow behind the task-name heading.

## Validation

- Focused ESLint: passed.
- Scheduled-task request and Assistant UI tests: `34 passed`, `0 failed`, `387 assertions`.
- Mobile production build: passed; Vite retained the repository's existing KaTeX font-path and chunk-size warnings.
- Dead-code scan: completed with exit code 0 and the repository's existing unused/duplicate-export reports.

final result: passed

---

# Mobile Assistant independent-card typography and shadow QA

## Comparison inputs

- Source visual truth: the existing Project tab card system at `/Users/yee.wang/.codex/visualizations/2026/07/24/019f9217-60e5-7a92-b084-ff3bbc320d57/mobile-project-typography-reference.png`, plus the reported focused-card defect at `/var/folders/5l/tlc329r51b17td86h3klclbw0000gn/T/codex-clipboard-cc4ab333-ec87-4f9a-8e66-6fa980717de5.png`.
- Browser-rendered implementation after opening an Assistant and returning: `/Users/yee.wang/.codex/visualizations/2026/07/24/019f9217-60e5-7a92-b084-ff3bbc320d57/mobile-assistant-independent-cards-shadow-retained.png`.
- Full-view side-by-side comparison: `/Users/yee.wang/.codex/visualizations/2026/07/24/019f9217-60e5-7a92-b084-ff3bbc320d57/mobile-project-assistant-card-shadow-comparison.png`.
- Source and implementation browser captures: `393 × 852` CSS px at device scale factor 1, light theme. The defect screenshot is a framed, scaled capture and is used only to identify the pressed/focused shadow regression.
- State: Project root reference beside Assistant root after `Assistant → 小小白 → Back`, with the first Assistant card still focused.

## Findings and comparison history

- Initial P1: all Assistants were rendered as rows inside one floating container, so individual Assistants did not read as independent destinations. Fixed by giving each Assistant its own shared `MobileFloatingSurface`; the browser now measures two separate `72px` cards with a `12px` gap and the shared `24px` surface radius.
- Initial P2: Assistant title and prompt treatment did not share the compact Project card hierarchy. Fixed by extracting shared mobile entity typography tokens and applying them to both Project and Assistant cards. Browser-computed values are `16/20px`, weight `600` for titles and `13/16px` for one-line metadata/subtitles.
- Initial P2: after opening a conversation and returning, programmatic focus triggered the global focus reset and removed the card's box shadow. Fixed by moving elevation ownership to the non-focusable shared surface wrapper. The focused button may retain `box-shadow: none`, while its card wrapper retains the complete three-layer `--oc-mobile-float-shadow`; computed border width remains `0px`.
- Post-fix visual evidence shows both Assistant cards retaining equal elevation, including the first focused card. No P0/P1/P2 issue remains.

## Required fidelity surfaces

- Fonts and typography: Assistant title and subtitle now use the same shared title/meta tokens as Project cards. Long prompts stay on one line and truncate before the chevron.
- Spacing and layout rhythm: each Assistant is an independent 72px card; 12px inter-card spacing, 12px internal padding, compact 40px avatar control, and the shared 24px radius preserve the Project-tab rhythm at lower density.
- Colors and visual tokens: card material, pressed feedback, muted subtitle, and elevation use the existing semantic floating-surface tokens. No border or palette color was added.
- Image quality and asset fidelity: existing `AgentAvatar` and sprite chevron assets are reused; no replacement illustration or generated asset is required.
- Copy and content: Assistant name, mode, and prompt remain DTO/localization-driven; only their presentation and truncation changed.

## Interaction and runtime verification

- Opened `小小白`, returned to the catalog, and verified the original card retained focus and the shared floating shadow.
- Repeated the flow with `Idea`; no new console entry was emitted during the interaction window.
- The Assistant catalog remained scrollbar-free at the `393 × 852` viewport.

## Validation

- Focused ESLint: passed.
- Assistant UI, Assistant view, and mobile share bridge tests: `36 passed`.
- Mobile production build: passed; Vite retained the repository's existing KaTeX font-resolution, circular-reexport, and chunk-size warnings.

final result: passed

---

# Mobile Assistant catalog and conversation QA

## Comparison inputs

- Source visual truth: `/var/folders/5l/tlc329r51b17td86h3klclbw0000gn/T/codex-clipboard-192e2961-257a-46d4-ba43-bfd237ba321e.png`
- Browser-rendered Assistant catalog: `/Users/yee.wang/.codex/visualizations/2026/07/24/019f9217-60e5-7a92-b084-ff3bbc320d57/mobile-assistant-catalog.png`
- Browser-rendered Assistant conversation: `/Users/yee.wang/.codex/visualizations/2026/07/24/019f9217-60e5-7a92-b084-ff3bbc320d57/mobile-assistant-conversation.png`
- Full-view comparison evidence: `/Users/yee.wang/.codex/visualizations/2026/07/24/019f9217-60e5-7a92-b084-ff3bbc320d57/mobile-assistant-comparison.png`
- Source pixels: `931 × 1540`, framed mobile preview in dark theme.
- Implementation pixels and CSS viewport: `393 × 852` at device scale factor 1, app content only, light theme.
- Density normalization: the source was aspect-contained into a `393 × 852` comparison cell; the implementation was captured 1:1 at `393 × 852`. Theme and framing differences are runtime state, not implementation drift.
- States: Assistant root catalog, selected Assistant second-level conversation, and return-to-catalog.

## Findings and comparison history

- Initial P0: the Assistant root tab mounted the selected conversation directly and could return no visible content while selection/session binding settled. Fixed by making the root tab render the authoritative Assistant snapshot as a visible catalog and by rendering a bounded loading state while a selected Assistant session is being ensured. Post-fix evidence shows two real Assistant rows instead of an empty page.
- Initial P1: mobile selection lived in a trailing header chip and overlay, obscuring the intended parent-child hierarchy. Fixed by routing catalog selection into the shared mobile second-level page. The conversation header now contains Back, avatar, name, and mode only; measured trailing selector count is `0`.
- Initial P2: a native scrollbar appeared beside the large title. Fixed by keeping catalog scrolling on the root tab panel and applying the shared hidden-scrollbar contract directly to that panel. Browser evidence reports `scrollbar-width: none`, a `0px` scrollbar width, and `clientHeight === scrollHeight === 852px` in the captured catalog state.
- Initial P2: conversation entry could briefly flash an empty frame before `ensureAssistantSession` completed. Fixed with a semantic skeleton that retains the second-level header and Back action during binding.
- No actionable P0/P1/P2 difference remains after the post-fix comparison. The source's empty body, trailing selector, and scrollbar are the defects this iteration intentionally removes.

## Required fidelity surfaces

- Fonts and typography: the root keeps the shared 2rem mobile page title; Assistant rows use the existing UI label/micro scales, two-line truncation, and conversation header hierarchy. Long names and hints truncate without pushing actions off-screen.
- Spacing and layout rhythm: catalog starts `20px` below the 35.2px title, uses one 179px content-height floating card for two rows, shared 24px outer radius, 14px row padding, and the existing bottom dock geometry.
- Colors and visual tokens: catalog material, row active state, muted metadata, focus ring, avatar backing, and shadows use semantic OpenChamber tokens. No palette color or hardcoded product color was introduced.
- Image quality and asset fidelity: existing `AgentAvatar` and sprite `Icon` assets are reused; no CSS art, inline SVG, emoji substitution, or raster placeholder was added.
- Copy and content: visible names and prompts come from the Assistant DTO; mode and accessibility labels use existing localized messages.

## Interaction and runtime verification

- Opened Assistant from the bottom tab and observed the real two-row catalog.
- Selected `小小白`; the page opened as a `393px`-wide modal secondary surface with the existing transcript and composer.
- Verified a 56px conversation header, Back label, selected Assistant identity, no trailing selector, and a hidden transcript scrollbar (`0px` width, `scrollbar-width: none`).
- Activated Back and returned to the catalog; focus restored to the Assistant row that opened the conversation.
- Browser console errors after the verified flow: none.

## Validation

- Focused ESLint: passed.
- Assistant UI, Assistant view, and mobile share bridge tests: `36 passed`.
- Mobile production build: passed; Vite retained the repository's existing KaTeX font and chunking warnings.
- `bun run build:ui`: reached TypeScript and remains blocked only by the three pre-existing `useConfigStore.test.ts` errors (`key`, `headers`, and `toHaveProperty`).

final result: passed

---

# Native detail-navigation system

## Shared contract

- Root tabs retain their large title. Entering a settings detail suppresses that root title and reveals the compact, centered secondary navigation title instead.
- `oc-mobile-detail-navigation` is the shared secondary-page bar for settings, session conversations, and scheduled-task editing. It owns the semantic separator, theme-color fade, title scale, and action geometry.
- `oc-mobile-detail-navigation-sticky` keeps settings navigation pinned while the tab panel scrolls. Scheduled-task editing separates navigation from its scroll container, so the title and back action remain fixed by layout.
- `oc-mobile-detail-action` is the common 40–44 px circular return/overflow control. It uses the shared float material and respects the dark-mode black-shadow override.
- Settings home and detail pages consume one mobile Settings token family from `settings.css`: 12/16 section labels, 14/18 row labels, 12/16 helper text, 52px standard rows, 8px label-to-card spacing, 20px section rhythm, 16px card radius, and one semantic card background.
- Detail cards deliberately use the borderless variant of that shared material: no outer border and no highlight shadow. Only inset row separators remain. Their titles sit outside the card using the same section-label recipe as Settings home.

## Browser verification

- Settings home and Appearance were measured from the running UI. Both resolve section labels to `12px / 16px`, row labels to `14px / 18px`, standard rows to `52px`, card radius to `16px`, and label-to-card spacing to `8px`; detail resolves its card border to `0px none` and shadow to `none`.
- Regression reproduction at `393 × 852`: the mobile tab shell was active while `useDeviceInfo()` still reported desktop in a non-touch browser preview. Appearance consequently rendered the desktop form tree inside the mobile detail shell. The mobile Settings owner now passes its flow explicitly, so the component no longer infers this contract from pointer hardware.
- Appearance now renders eight explicit shared `SettingsGroup` instances and eighteen explicit `SettingsRow` instances. All eight cards measure `357px` inside the `393px` viewport; the document and tab panel both retain a `393px` scroll width, with no page-level horizontal overflow.
- PWA app name, install orientation, and mobile keyboard behavior are separate titled groups rather than one oversized desktop card. Layout/font controls use the same two-column row primitive, compact token typography, inset separators, and borderless semantic background.
- The fixed Appearance header resolves to a `64px` sticky bar at `top: 0`, with an opaque theme surface and a theme-color-to-transparent fade below it. Scrolled content no longer ghosts through the title or back action.
- Light-mode comparison capture: `/Users/yee.wang/.codex/visualizations/2026/07/24/019f92a1-fcf2-79a1-af41-09e493082e2f/mobile-appearance-final-top-light-393x852.png`.
- Installation/layout capture: `/Users/yee.wang/.codex/visualizations/2026/07/24/019f92a1-fcf2-79a1-af41-09e493082e2f/mobile-appearance-final-install-layout-light-393x852.png`.
- Mobile viewport `431 × 960`: scheduled tasks → Create renders the same fixed secondary navigation, with form content independently scrollable below it.
- Focused ESLint and `bun run mobile:build` passed. The build retains the repository's existing KaTeX font-path warnings.

---

# Mobile content-sized action sheet QA

## Comparison inputs

- Source visual truth: `/var/folders/5l/tlc329r51b17td86h3klclbw0000gn/T/codex-clipboard-026247ed-f987-4e2f-9d68-45a0bc2d2226.png`
- Browser-rendered implementation: `/Users/yee.wang/.codex/visualizations/2026/07/24/019f9217-60e5-7a92-b084-ff3bbc320d57/mobile-row-actions-fit-content.png`
- Focused side-by-side comparison: `/Users/yee.wang/.codex/visualizations/2026/07/24/019f9217-60e5-7a92-b084-ff3bbc320d57/mobile-row-actions-fit-content-comparison.png`
- Implementation viewport: `393 × 852` CSS px at device scale factor 1, light theme, session action sheet open in its collapsed state.
- Source pixels: `1038 × 956`. The sheet crop (`752 × 896`) was normalized 2:1 to `376 × 448` for comparison. The implementation sheet crop (`393 × 358`) was width-normalized to `376 × 343`.

## Findings and comparison history

- Initial P1: the shared sheet forced compact actions to `72dvh`, leaving a large empty region below the final action. Fixed by adding the reusable `fitContent` mode: content determines collapsed height and `72dvh` is now only the maximum. Post-fix browser evidence measures `358px` natural height against a `613.44px` maximum.
- Initial P2: the title header had a visible bottom divider. Fixed in the shared `MobileResizableSheet` header; computed bottom border is now `0px` with no replacement box shadow.
- Initial P2: the shared bottom-sheet top radius was too tight. Increased the shared bottom radius from `12px` to `16px`; browser evidence reports `16px` on both top corners.
- Intentional source differences: the source screenshot still contains the divider and excess bottom whitespace that this request explicitly removes. Those differences are expected, not fidelity regressions.

## Required fidelity surfaces

- Fonts and typography: existing localized title/action typography, weights, truncation, and icon alignment are preserved.
- Spacing and layout rhythm: the action stack ends after the destructive row plus safe-area padding; no forced blank region remains. Header and row spacing remain on the shared component scale.
- Colors and visual tokens: all surfaces, muted text, drag handle, and destructive treatment continue using semantic theme tokens; no hardcoded color was added.
- Image and icon fidelity: no raster asset is required for this surface; all icons remain shared sprite icons.
- Copy and content: existing localized session action labels are unchanged.

## Interaction and runtime verification

- Opened the sheet from a real session overflow action in the authenticated mobile preview.
- The drag handle remains present and interactive. Its accessible toggle expanded the surface from `358px` to `834.95px` (`98dvh`) and returned it to `358px`.
- The content-sized dismissal baseline is covered by focused tests so a short sheet is not immediately dismissed at rest.
- No new browser console error was emitted after the full reload and verification sequence; the claimed long-lived preview tab retained only earlier HMR hook-order entries from before the reload.

## Residual gaps

- The in-app browser's coordinate drag did not synthesize a reliable continuous pointer gesture for this handle. Pointer math, content-sized snap selection, and dismissal thresholds are covered by focused tests; direct touch-device verification remains a platform follow-up.
- `bun run build:ui` remains blocked by the three pre-existing `useConfigStore.test.ts` type errors (`key`, `headers`, and `toHaveProperty`), unrelated to this change.

## Validation

- Focused ESLint: passed.
- Mobile window, dismissal, session-sheet, edge-swipe, and header-swipe tests: `88 passed`.
- Mobile production build: passed; Vite retained the existing unresolved KaTeX font-at-build-time warnings.
- Dead-code scan: completed with exit code 0 and the repository's existing generated-asset/unused reports.

final result: passed
