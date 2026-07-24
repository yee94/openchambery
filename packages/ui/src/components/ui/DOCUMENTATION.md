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

`MobileResizableSheet` is the product-level assembly for standard resizable mobile sheets. It combines `MobileWindowMotion`, `MobileSheetSnapHandle`, the shared snap lifecycle, an optional title or leading action, and the close action. Picker sheets with neither a title nor leading navigation omit the header row entirely and move directly from the resize handle into content; nested picker views may retain the borderless navigation row for their leading back action. Current-turn and direct single-file diff viewers retain contextual titles. Sessions uses the same lower-level pieces with its custom action-only header and interactive-present bridge.

Feature-owned sheets may pass `bodyClassName` to `MobileResizableSheet` for local body layout treatment. When present, the shared header remains borderless and owns its close action and accessibility contract; features must not restore an empty picker header or picker-title divider locally. The shared sheet always owns its motion and resize handle.

`MobileResizableSheet` also supports `fitContent` for compact action surfaces. In that mode the collapsed sheet follows its content height up to the shared `72dvh` maximum instead of being forced to that height. Dragging still expands toward `98dvh`, and downward dismissal uses the measured content-sized collapsed height as its threshold baseline.

`keepMounted` preserves a surface's Portal subtree after its first presentation. A preserved hidden surface leaves the modal stack, releases body and focus ownership, becomes inert and invisible, and retains child state and native scroll position for its next presentation. The mobile Sessions window enables this behavior while continuing to refresh authoritative session snapshots when opened.

`MobileOverlayPanel` keeps its scrollable body as the default. Its opt-in `containedBody` mode provides a fixed, overflow-contained body for children that own their internal scroll region, including the scheduled-tasks workspace and its editor page.

`MobileDetailNavigation` owns the safe-area-aware header used by mobile secondary pages. It provides the shared back action, centered title grid, optional trailing content, sticky behavior, and the Apple-style one-rem physical screen-edge inset for circular navigation actions. Settings detail pages, scheduled-task editing, session chat, and Assistant conversations use this component instead of recreating the navigation markup or its sizing locally. The shared content node owns its horizontal inset and safe-area calculation; parent layouts must not redefine the inset or apply a compensating negative margin to the header.

Phone headers use the shared `Button` `mobileGlass` variant with the `mobileIcon` size for neutral floating circular actions such as back, search, and trailing navigation. These controls must consume that pair instead of rebuilding their background, blur, theme-specific elevation, focus ring, or 40px geometry locally. Their dark treatment uses an opaque-leaning elevated glass fill, a low-contrast hairline border, and flat elevation; light mode retains the floating shadow. Primary create actions keep the same circular geometry and use the semantic primary fill and matching primary shadow so their action hierarchy remains visible.

`mobileBackNavigation.ts` owns phone push-depth coordination across Chat/Assistant secondary pages, Settings details, scheduled-task editing, file details, and Changes diffs. Route owners retain their authoritative local state and explicitly register the compositor surface and, for root pushes, its matching underlay; the driver must never infer either layer by querying an ancestor DOM subtree. Native progress never enters React state: iOS edge-pan samples are reduced through a 60 Hz native display link, Android Predictive Back supplies system progress, and the web driver coalesces both to one transform-only write per animation frame. Static compositor styles are applied once at begin. Settlement copies its visual endpoint into the inline transform before cancelling fill-forwards, synchronously commits a successful route pop while the outgoing surface remains off-screen, and only then clears presentation styles; WebKit must never expose the outgoing page at x=0 between animation completion and React route mutation. The phone tab shell keeps both its active tab and dock mounted and inert behind the opaque secondary surface, so an interactive pop reveals a complete previous-page snapshot without late mounting or background input. The dock remains a separate viewport-fixed retained layer outside the transformed content underlay; putting it below a transformed ancestor changes WebKit's fixed-position containing block by the native bottom safe-area height and causes a completion bounce. Flow-mobile Settings and Scheduled Tasks each keep one persistent, viewport-bounded root layer mounted across root/detail stages and place the detail in a separate viewport-bounded push surface. These roots own their vertical scroll, clip horizontal overflow, and are the only underlays translated during an interactive pop; a long tab document or an ancestor that also contains the outgoing surface must never become the compositor underlay. Modal and sheet dismissal remains a separate overlay contract; only a push detail inside an overlay can pre-empt its owner's close action. Hosted H5 installs no touch recognizer and mirrors registered push depth into `history.pushState`; `popstate` dispatches through the same top-route callback while root browser navigation remains browser-owned.

The flow-mobile Settings root and its push-detail surface both use
`--surface-background`; grouped cards provide the local material contrast.

`mobileLongPress.ts` owns the shared 500ms touch/pen hold controller for mobile action surfaces. It cancels on movement beyond 12px, release, or pointer cancellation and consumes the click generated by a completed hold. Both dedicated mobile sessions and the responsive Web sessions sheet use this controller.

## Dialog Surfaces

`DialogContent` owns both the popup surface and its backdrop. Feature-specific dialog treatments pass popup styling through `className` and backdrop styling through `overlayClassName`; this keeps blur and dimming local to the owning dialog without changing every modal surface.

## Grouped Cards

The normative visual and structural contract is
[`../sections/shared/SETTINGS_DESIGN_SPEC.md`](../sections/shared/SETTINGS_DESIGN_SPEC.md).
All Settings pages, including desktop and mobile secondary pages, must follow
that specification rather than defining feature-local typography or spacing.

`grouped-card.styles.ts` exports compatibility aliases for compact editor surfaces that map directly to the Settings group, row, divider, and section-label classes. Scheduled Tasks uses those aliases inside the same `oc-settings-workspace` / `oc-settings-page-content` form root, so its cards and controls consume the identical Settings tokens instead of maintaining a second visual recipe. The phone tab panel owns the shared page gutter for Scheduled Tasks root controls and the task catalog, so those descendants must not add a second horizontal inset. The in-tab editor is an independent viewport-bounded push surface: its outer layer is overflow-contained, while one inner body owns vertical scrolling and exactly one `--oc-mobile-page-inline-inset` instead of relying on the retained root underlay's gutter. It keeps the shared secondary-page navigation above that body and reserves the same root-dock clearance at the end of the form. Its Enabled / Save controls are a sibling of the scrolling body and use `MobileFloatingBottomBar`, the same viewport position, width, radius, glass material, and safe-area treatment as the root tab bar; the shared frame is explicitly viewport-wide so a contained editor scrollbar cannot narrow or offset the capsule. The page must not put this fixed bar inside the scrolling element or recreate a full-width painted footer behind it.

Settings detail pages compose the same grammar through `components/sections/shared/SettingsGroup.tsx`. `SettingsGroup` owns an optional section label and one grouped card; `SettingsField` is the required primitive for a standalone setting, keeping its label and short helper text inside that card. Helper text known to wrap uses `descriptionPlacement="outside"` so the standard smaller gray description sits below the card instead of compressing the label/control columns. `SettingsRow` owns the responsive label/value grid, control alignment, long-text containment, and `data-settings-item` anchor. The components and their `styles/settings.css` layout tokens are shared by desktop and narrow/mobile Settings surfaces. Feature pages must not recreate separate desktop and mobile column markup or depend on DOM-shape selectors for new Settings groups.

Full-row Boolean settings use `SettingsToggleRow`. It owns checkbox-first
alignment, the standard row typography, and pointer/keyboard activation while
preventing the nested checkbox from toggling twice. A bare `Checkbox` remains
appropriate when it is only the right-column control of a true label/value
`SettingsRow`.

`SettingsRow` marks its right column with `data-settings-value`. Editable Settings controls expose semantic `data-slot` values. Select, Input, and NumberInput consume the global `--form-*` design tokens for height, radius, font size, line-height, and helper text inside that value column; they render as right-aligned inline values by default, with a transparent reserved border that becomes visible on hover/focus without moving content. Custom value pickers that do not expose one of those slots add `oc-settings-inline-value` to their trigger. Page code must not assign a separate visual border, alignment, or geometry contract. Rows are direct children of the grouped card so the card can draw one consistent divider after every non-final row, including conditionally rendered rows. Settings page and section stacks use one `--oc-settings-section-stack-gap`; wrappers must not add page-specific top margins, padding gaps, or divider gaps between sibling groups.

Desktop Settings navigation preserves the `main` branch's flat sidebar recipe instead of consuming mobile navigation-card styling: 32px rows, 8px horizontal insets, compact row spacing, sidebar surface color, and semantic selected/hover states remain owned by `SettingsView`. Mobile navigation continues to use `MobileSettingsGroup` and its shared card tokens. Detail rows reserve one right-aligned value column capped by `--oc-settings-desktop-value-max-width`; the cap includes adjacent reset actions and also applies to fields that stack on mobile. Select and Input may fill that column, while NumberInput remains intrinsic-width and is aligned to its right edge. Feature pages must not add local desktop widths to Select, Input, or NumberInput controls.

The desktop detail pane adds no workspace-level padding. Split collections and page bodies retain their owning layout insets instead of receiving a second outer gutter from the Settings shell.

Settings section labels use normal font weight on every surface. Desktop detail labels use the base UI-label size and line height, while mobile retains the more compact section-label size. Section consumers must not override those responsive title metrics locally.

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
