# File type icons

`FileTypeIcon` is shared by file trees, file tabs and file references. Its default
SVG sprite comes from `lib/fileTypeIcons.ts`; directories always use that default.

GUI plugins can register static SVG file icons through the official custom
`Registry` mechanism with the `yuri.file-icon` registry ID. The host validates and
owns these contributions; this is an optional Yuri consumer, not an upstream
OpenCode built-in registry. See `lib/gui-plugins/DOCUMENTATION.md` for the contract.

`GuiFileIconsContext` carries only the runtime's stable icon registry. Each icon
uses an external-store snapshot containing its resolved data URI; it does not
subscribe to the broad plugin/session snapshot. Plugin changes update the image,
and disabling a plugin or switching runtimes restores the built-in fallback.
SVG is loaded as a decorative image, never injected into the host DOM. Image
decode failure falls back to the normal sprite until the icon source changes.
