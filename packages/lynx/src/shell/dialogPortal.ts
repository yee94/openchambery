/**
 * Cap DialogPortal spirit for Lynx — mount centered dialogs at the **shell root**
 * as a full-screen overlay, not nested `position:absolute` inside a Changes
 * (or other sheet) `position:relative` container.
 *
 * Cap `Dialog` uses `DialogPortal` to document body. Lynx has no DOM portal;
 * `LynxShellDialogPortalProvider` hosts overlay content at `LynxShellApp` root.
 */

export const LYNX_SHELL_DIALOG_PORTAL = {
  /** ShellApp page root — covers chat/sheet/dock chrome. */
  mountPoint: 'shell-root' as const,
  /** Full-screen overlay (Cap DialogPortal spirit). */
  placement: 'full-screen-overlay' as const,
  /** Must not nest under Changes relative scroll host. */
  nestedInRelativeSheet: false as const,
  /** Above sheet chrome; matches centered dialog z-index. */
  zIndex: 50 as const,
} as const;

export const LYNX_SHELL_DIALOG_PORTAL_NOTES = [
  'Cap DialogPortal spirit: LynxShellDialogPortalHost at LynxShellApp root (full-screen overlay).',
  'Do not nest LynxCenteredDialog absolute inside Changes position:relative container.',
  'Lynx has no DOM createPortal — provider teleports children to shell host.',
  'Linux JS wiring — 真机 residual. NOT DONE.',
] as const;
