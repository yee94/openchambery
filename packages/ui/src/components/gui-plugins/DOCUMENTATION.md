# GUI plugin UI boundary

File previews render inside the existing FilesView tab or MobileFileDetail body.
`GuiFileLinkBridge` registers that visible file surface before dispatching its
LinkHandler. The host matches the contribution's explicit `PanelTab.file` against
the normalized absolute file path; an inline-owned panel never opens a modal.
`GuiPluginSurface` remains mounted once for errors and standalone panels without
an inline file owner. `GuiPluginWindow` supplies Dialog/Sheet for those standalone
panels and settings pages only.

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

## Deferred loading

The provider initially fetches inventory only. A visible, active file bridge,
the mounted Plugins manager, or the open command-palette plugin group calls
`requestLoad()`. Closed command palettes and inactive/inert/hidden file views
must not trigger GUI downloads. Demand is retained for the current runtime so
closing and reopening a file reuses the loaded host and bundle queries.

The standard inventory only declares `features.gui`; file matchers are registered
by plugin setup. The first demand therefore loads enabled GUI plugins, not a
guessed extension-specific plugin. Server-only and disabled plugins are excluded.
File views display loading feedback above usable source content, then mount a
matching preview inline. Ready handlers may render while other bundles are still
pending. Failed loading exposes reload next to the error and keeps source usable;
the command group also exposes loading and retry, while the manager retains its
existing reload control. Runtime changes reset demand; mounted entrypoints request
the new runtime explicitly.

`GuiFileLinkBridge` wraps file content and calls `openLink` with the selected path,
exact matching and the workspace base. It does not fetch file contents. A matching
file panel is the default preview, with one icon-only source/edit toggle; normal source/image
content remains the fallback when no panel matches or the plugin is disabled.
Source mode releases the Solid mount while retaining the parent editor draft.
FilesView and MobileFileDetail place the toggle in their existing floating/docked
toolbar or header actions through the bridge's render slots. There is no separate
plugin mode bar, and unmatched files receive no plugin controls.
Closing or switching the file releases its presentation lease and hides its old
active plugin panel instead of reopening it as a dialog. Multiple consumers have
independent leases. Desktop FilesView also passes its active-view state. Inert/hidden ancestors cannot initiate
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
delayed bundle loading with source fallback, inline file-content rendering, warm
reopening and failed download/reload. SDK/file I/O and the standalone surface are
fixtures; plugin-specific runtimes and browser execution belong to the independent
plugin projects.
