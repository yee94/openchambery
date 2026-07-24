# Mobile Window Motion

`MobileWindowMotion` owns mobile overlay motion. React owns discrete presence and modal state. Interaction frames write only the component-owned scrim and surface `transform` and `opacity` styles.

`begin(operation)` accepts `present` and `dismiss` and returns whether the interaction started. `update(progress)` receives the current operation completion from `0` through `1`: present maps directly to visible progress, dismiss maps to `1 - progress`. `finish(commit | cancel)` resolves through the recipe: present commits visible and cancels hidden; dismiss commits hidden and cancels visible.

Modes are `standard`, `interactive-present`, and `interactive-dismiss`. Each interaction has a generation; stale updates and settlements cannot affect a newer interaction. Settlement reads the latest controlled `open` value after requesting its commit, then converges to the controlled endpoint before unmounting.

`MobileWindowStack` owns shared modal ordering and body locking for Motion instances. Its first modal saves and locks body overflow; its final modal restores it. Escape, focus trapping, and `aria-modal` apply to the stack top. Lower stack entries receive `aria-hidden` and `inert`. Present previews mount with `aria-hidden` and `inert` and remain outside the stack.

Frame updates use one rAF to coalesce input. Interaction frames avoid root CSS variables, global DOM queries, layout reads, and per-frame React state. Sheet layouts derive from their edge. WAAPI owns settling, interruption reads the active computed progress, and reduced-motion completes synchronously. Capacitor Motion surfaces disable keyboard-bottom transitions while interaction or settlement owns compositor opacity.

`MobileWindowMotionRegistry` provides a narrow imperative bridge and unregisters controllers when the component unmounts or its id changes. Controller lifetime remains independent from surface presence. The mobile Sessions sheet is the current first caller and starts its header-swipe preview with `begin('present')`. Future callers may use the registry for local gesture ownership while keeping presence, modal state, and visual-frame ownership inside `MobileWindowMotion`.

The Sessions sheet exposes a dedicated top resize handle with `72dvh` and `98dvh` snap points. Drag frames write height directly to the motion surface through `surfaceElementRef`, one write per animation frame; release settles with a height animation and React commits the selected snap class. The handle is reserved from the sheet-wide dismiss recognizer, while list-edge downward gestures continue to own dismissal. Current-turn and direct single-file mobile diffs open at `98dvh` and use the same resize behavior. Both presentations include backdrop dismissal and an explicit close action.

`MobileWindowMotion` owns dismissal configuration through `dismissGesture`: its default is disabled, `true` uses defaults, and an object enables the gesture with option overrides. Motion attaches the hook to its real surface, which supplies the edge and surface travel size. The hook supports `top`, `bottom`, `left`, and `right`; it locks scroll ownership at `touchstart` by choosing the nearest target-axis scrollable ancestor. A matching selector provides a checked fallback within the surface. A target scroll container keeps the full gesture when the touch starts away from its matching edge, and a later touch starting at that edge becomes eligible for dismissal. Commit distance uses its own ratio and min/max bounds, separate from the surface-sized animation travel; a correctly directed fling can also commit.

`MobileSheetSnap` owns the shared `72dvh` / `98dvh` resize gesture and accessible drag handle used by Sessions and mobile diffs. The handle can move upward to `98dvh` and continuously downward to zero; releasing below the dismissal threshold closes the owning sheet, while shorter gestures settle to the nearest snap.

`MobileResizableSheet` is the product-level assembly for standard resizable mobile sheets. It combines `MobileWindowMotion`, `MobileSheetSnapHandle`, the shared snap lifecycle, an optional title or leading action, and the close action. Picker sheets use the action-only header without a divider; current-turn and direct single-file diff viewers retain contextual titles. Sessions uses the same lower-level pieces with its custom action-only header and interactive-present bridge.

Feature-owned sheets may pass `bodyClassName` to `MobileResizableSheet` for local body layout treatment. The shared header remains borderless and owns its motion, resize handle, close action, and accessibility contract; features must not restore a picker-title divider locally.

`MobileResizableSheet` also supports `fitContent` for compact action surfaces. In that mode the collapsed sheet follows its content height up to the shared `72dvh` maximum instead of being forced to that height. Dragging still expands toward `98dvh`, and downward dismissal uses the measured content-sized collapsed height as its threshold baseline.

`keepMounted` preserves a surface's Portal subtree after its first presentation. A preserved hidden surface leaves the modal stack, releases body and focus ownership, becomes inert and invisible, and retains child state and native scroll position for its next presentation. The mobile Sessions window enables this behavior while continuing to refresh authoritative session snapshots when opened.

`MobileOverlayPanel` keeps its scrollable body as the default. Its opt-in `containedBody` mode provides a fixed, overflow-contained body for children that own their internal scroll region, including the scheduled-tasks workspace and its editor page.

`MobileDetailNavigation` owns the safe-area-aware header used by mobile secondary pages. It provides the shared back action, centered title grid, optional trailing content, sticky behavior, and the Apple-style one-rem physical screen-edge inset for circular navigation actions. Settings detail pages, scheduled-task editing, session chat, and Assistant conversations use this component instead of recreating the navigation markup or its sizing locally; parent tab gutters may extend the header to the viewport edge but must not redefine its action inset.

`mobileLongPress.ts` owns the shared 500ms touch/pen hold controller for mobile action surfaces. It cancels on movement beyond 12px, release, or pointer cancellation and consumes the click generated by a completed hold. Both dedicated mobile sessions and the responsive Web sessions sheet use this controller.

## Dialog Surfaces

`DialogContent` owns both the popup surface and its backdrop. Feature-specific dialog treatments pass popup styling through `className` and backdrop styling through `overlayClassName`; this keeps blur and dimming local to the owning dialog without changing every modal surface.

## Grouped Cards

`grouped-card.styles.ts` exports opt-in grouped-card recipes for compact settings and editor surfaces. `groupedCardClassName` owns the single elevated surface and outer border, `groupedCardRowClassName` owns consistent row height and inset separators, and `groupedSectionTitleClassName` owns the section label. Controls inside a grouped row keep their own interaction affordance while the row remains part of one shared card layer.

Settings detail pages compose the same grammar through `components/sections/shared/SettingsGroup.tsx`. `SettingsGroup` owns an optional section label and one grouped card; `SettingsField` is the required primitive for a standalone setting, keeping its label and short helper text inside that card. Helper text known to wrap uses `descriptionPlacement="outside"` so the standard smaller gray description sits below the card instead of compressing the label/control columns. `SettingsRow` owns the responsive label/value grid, control alignment, long-text containment, and `data-settings-item` anchor. The components and their `styles/settings.css` layout tokens are shared by desktop and narrow/mobile Settings surfaces. Feature pages must not recreate separate desktop and mobile column markup or depend on DOM-shape selectors for new Settings groups.

`SettingsRow` marks its right column with `data-settings-value`. Editable Settings controls expose semantic `data-slot` values. Select, Input, and NumberInput consume the global `--form-*` design tokens for height, radius, font size, line-height, and helper text inside that value column; they render as right-aligned inline values by default, with a transparent reserved border that becomes visible on hover/focus without moving content. Custom value pickers that do not expose one of those slots add `oc-settings-inline-value` to their trigger. Page code must not assign a separate visual border, alignment, or geometry contract. Rows are direct children of the grouped card so the card can draw one consistent divider after every non-final row, including conditionally rendered rows. Settings page and section stacks use one `--oc-settings-section-stack-gap`; wrappers must not add page-specific top margins, padding gaps, or divider gaps between sibling groups.

Desktop Settings keeps navigation groups flat rather than wrapping them in mobile-style cards. Detail rows reserve one right-aligned value column capped by `--oc-settings-desktop-value-max-width`; the cap includes adjacent reset actions and also applies to fields that stack on mobile. Feature pages must not add local desktop widths to Select, Input, or NumberInput controls.

## Select And Searchable Pickers

This is the required contract for new or revised `Select`, `DropdownMenu`, and searchable popup pickers in shared UI. Follow it instead of inventing local search chrome.

### Positioning

- Use shared `SelectContent` and `DropdownMenuContent` / `DropdownMenuSubContent`.
- Keep the shared defaults: `collisionPadding={8}` and `collisionAvoidance={{ side: 'shift', align: 'shift' }}`.
- Override collision props only with a documented product reason. Prefer shifting the popup so it stays fully on-screen near viewport edges rather than flipping off-screen.
- Size searchable popups with viewport-aware max height (`max-h-[var(--available-height)]` or an equivalent `min(...)` clamp). Do not let a long option list grow past the visible viewport.

### Search Field Chrome

Canonical look is the bordered shared `Input` style, not a flat bottom divider.

- Prefer shared `CommandInput` for `Command` / `DropdownMenu` searchable lists. It already matches bordered `Input` chrome.
- Prefer shared `Input` for search headers inside `SelectContent` (for example draft project pickers).
- Wrapper padding for the search row is `p-1.5 pb-1`.
- Dense picker search fields are typically `h-8` with a leading search icon.
- Keep the ring treatment: inset `ring-border/60`, hover subtle surface, focus `interactive-focus-ring`.
- Do not force borderless overrides such as `ring-0`, `border-none`, `rounded-none`, or CSS that strips `command-input-wrapper` borders / hides the search icon. `CommandPalette` keeps its search field transparent so it inherits the palette surface while retaining its border and focus ring.
- Do not reintroduce the old `border-b border-border/40` search divider as the primary search-field affordance.
- Keep search placeholders localized through `locale-ui-patterns`.

### Primitive Selection

| Need | Shared pattern |
|---|---|
| Short fixed option set | `Select` + `SelectItem` |
| Searchable select list | `SelectContent` header + shared `Input` |
| Searchable menu / branch-style picker | `DropdownMenu` + `Command` + `CommandInput` |
| Global command search | `CommandPalette` / shared `Command` |

Reuse the shared primitives above. Do not add one-off popup search components or alternate search visuals for the same interaction.

### Review Checklist

- Popup stays inside the viewport with the shared collision defaults.
- Search chrome matches bordered `Input` / `CommandInput`, including focus ring.
- No local CSS undoes shared search borders, icons, or padding.
- Long lists scroll inside the popup instead of overflowing the window.
- Nearby searchable pickers (project, branch, model, agent, command palette) remain visually consistent.
