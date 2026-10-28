# GUI plugin UI boundary

File previews render inside the existing FilesView tab or MobileFileDetail body.
`GuiFileLinkBridge` registers that visible file surface before dispatching its
LinkHandler. The host matches the contribution's explicit `PanelTab.file` against
the normalized absolute file path; an inline-owned panel never opens a modal.
`GuiPluginSurface` remains mounted once for errors and standalone panels without
an inline file owner. `GuiPluginWindow` supplies Dialog/Sheet for those standalone
panels and settings pages only.

Explicit message file links and Changes' open-file actions navigate to the file
surface without a file-read or plugin-support preflight. Read failures stay in
that opened file tab; plugin render failures appear there through the bridge.
Changes row selection still defaults to diff. Background link probes annotate
inferred references but cannot veto explicit Markdown file-link navigation.

`GuiPluginMount` gives the host one empty DOM container. React never reconciles
the foreign descendants. Changing host, contribution key or contribution kind,
the owning plugin's readiness revision, closing the window, or removing the contribution
disposes the previous mount. The host should expose its bundle `revision` on each
snapshot plugin: React may batch uninstall/reinstall into one render, so id/status
alone cannot detect replacement of a settings renderer with the same key.
Panel and settings snapshots carry an explicit `pluginId`. Inline previews,
standalone panels, and manager settings mounts select readiness by that exact ID;
unrelated plugin reloads preserve their foreign DOM. Do not infer ownership from
the contribution key prefix: official plugin IDs are strings without a no-colon
constraint, so IDs such as `demo` and `demo:tools` can share a prefix.
Mount failures appear inline; cleanup failures are reported through the shared
toast while the container is still cleared. Locale changes update fallback copy
without remounting foreign content. Root-surface failure notifications remain
visible even when the host removes the failed active panel.

`GuiPluginsManager` appears in every PluginsPage branch. It reads inventory and
runtime statuses from the provider, delegates enable/reload actions, and opens
settings contributions. Its panel group also exposes `session.panel` menu-item
launchers, including when no panel is open yet. Launcher actions use the same
error-reporting path as other manager actions. Contribution rows are dynamic entities and are not
registered individually in Settings search. The owning Plugins page remains the
navigation entry. `GuiPluginCommands` is an independently filtered command-palette
group with five-row previews and explicit expansion.

Plugin keyboard shortcuts and slash-command autocomplete are not supported in
this first version. Command-palette and manager actions are the available command
entry points; contributed shortcut bindings are not installed by this UI.

## Preloading and preview preparation

The provider initially fetches inventory, then preloads active enabled GUI plugins
at browser idle (2s timeout, 1s timer fallback). A visible, active file bridge,
the mounted Plugins manager, or the open command-palette plugin group calls
`requestLoad()` to bypass that wait. Closed command palettes and inactive/inert/hidden
file views do not initiate demand themselves. Demand is retained for the current
runtime so closing and reopening a file reuses the installed host and bundle queries.
Persistent code is revalidated before installation; its transport and freshness
contract belongs to `lib/gui-plugins/DOCUMENTATION.md`.

The standard inventory only declares `features.gui`; file matchers are registered
by plugin setup. Preload or explicit demand therefore loads enabled GUI plugins, not a
guessed extension-specific plugin. Server-only and disabled plugins are excluded.
File views place `GuiPreviewLoading` in their existing preview slot, keeping file
tabs and toolbars in place. The centered, transparent file-content canvas reserves
at least 240px (including under the global mobile flex min-height reset) and inherits
the file surface rather than adding a card. The source action uses a visible keyboard
focus background even where global styles suppress focus rings. A decorative
SVG animates content-line opacity with CSS only; reduced-motion disables it. A
localized title and first-open hint describe preview preparation without implementation
terminology or cache assumptions. “View source” and the toolbar source toggle remain
usable before a host exists; source choice is retained for the file/base/session
identity, so a late preview cannot take over. Discovery completion without a match
removes the loading canvas and restores ordinary source with no plugin controls.
Ready handlers may render and switch to/from source while other bundles are still
pending. Failed loading removes the preparation canvas, exposes reload next to the error and keeps source usable;
the command group also exposes loading and retry, while the manager retains its
existing reload control. Runtime changes reset demand; mounted entrypoints request
the new runtime explicitly.

Ready/preloaded file panels also pass `GuiPreviewLoading` as `GuiPluginMount`'s
fallback. The mount yields across two animation frames before calling plugin code,
leaving a paint opportunity for the default SVG even when there is no bundle request.
The empty foreign container remains measurable; React owns only the sibling loading
overlay. Source selection, unmount, and owner/revision replacement cancel deferred
work. Unrelated renders and fallback-copy changes do not restart it. Synchronous
mount completion hands off to plugin-owned preparation; plugins with asynchronous
file reads or iframe runtimes must keep their own visible loading surface until
actual content commit or an actionable error, not merely iframe `load`/runtime-ready.
Standalone/settings mounts without a fallback retain synchronous layout mounting.

`GuiFileLinkBridge` wraps file content and calls `openLink` with the selected path,
exact matching and the workspace base. It does not fetch file contents. A matching
file panel is the default preview, with one icon-only source/edit toggle; normal source/image
content remains the fallback when no panel matches or the plugin is disabled.
Authoritative binary stat results use the shared file-view `BinaryFileFallback`
instead of reading or editing UTF-8; this fallback and its explicit system-open /
runtime-download actions are owned outside GUI plugins. Plugin previews retain
priority over that state. See `packages/ui/README.md#file-preview-fallback`.
Source mode releases the Solid mount while retaining the parent editor draft.
FilesView and MobileFileDetail place the toggle in their existing floating/docked
toolbar or header actions through the bridge's render slots. There is no separate
plugin mode bar, and unmatched files receive no plugin controls.
Closing or switching the file releases its presentation lease and hides its old
active plugin panel instead of reopening it as a dialog. Multiple consumers have
independent leases. Desktop FilesView also passes its active-view state. Mobile file
bridges combine this with `MobileWindowActiveContext`, the owning window's reactive
top-of-stack state. Initial inert mount, interactive-present, a covering window and
reactivation therefore release/reacquire the file lease and retry matching without
waiting for a plugin update. Reading ancestor attributes alone is insufficient: a
preloaded plugin can be ready before the sheet is admitted to the window stack.
Source selection survives covering/uncovering. Inert/hidden ancestors cannot initiate
an automatic preview. Initial plugin registration, a new file/base, host replacement,
an updated plugin revision, session change or an observed loading cycle retries matching. Panel
snapshots alone do not.
Link discovery deliberately uses all plugins' readiness so newly available or
reloaded handlers can match a file. This retry signature is separate from the
owner-scoped mount revision: retrying matching does not itself recreate an
existing preview. Inline mount revisions also include session identity.
Reloads that preserve both host identity and the plugin status signature do not
force a preview open: the preview icon retries the same file,
as does leaving and reopening file detail. React strict effect replay does not
duplicate an automatic link opening.

The integration tests mock the provider and host boundary and use real React DOM.
They cover foreign DOM lifetime, error visibility, settings removal, tab actions,
file routing, deferred entrypoints, loading/retry and repeated snapshot no-ops. They do not prove Solid rendering,
actual mobile gestures, native focus, network bundle loading or runtime transport.

`GuiPluginLazyLoading.test.tsx` additionally composes the real provider, file bridge,
host and a minimal standard CJS fixture. It covers cold startup without downloads,
delayed bundle loading with a source action, retained source choice, inline file-content rendering, warm
reopening and failed download/reload. SDK/file I/O and the standalone surface are
fixtures; plugin-specific runtimes and browser execution belong to the independent
plugin projects.
