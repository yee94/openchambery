/**
 * Cap PierreDiffViewer — honest Lynx thin stub.
 *
 * Cap Changes sheet mounts `@/components/views/PierreDiffViewer` for
 * side-by-side / unified polish. Lynx already loads real `/api/git/file-diff`
 * + `/api/git/diff` text; until a Lynx-capable Pierre/runtime CSS port exists,
 * present unified/original+modified as monospace text with an explicit stub note.
 *
 * Source: packages/ui/src/apps/MobileChangesSurface.tsx
 */

export type LynxPierreDiffPlan = {
  /** Real file/turn diff text is available from Cap APIs. */
  hasTextPreview: boolean;
  /** PierreDiff interactive viewer — not ported to Lynx. */
  pierreViewer: 'stub';
  note: string;
};

export const planLynxPierreDiff = (input?: {
  unifiedDiff?: string | null;
  original?: string | null;
  modified?: string | null;
  binary?: boolean;
}): LynxPierreDiffPlan => {
  if (input?.binary) {
    return {
      hasTextPreview: false,
      pierreViewer: 'stub',
      note: 'Binary file — no PierreDiff / text preview.',
    };
  }
  const hasText = Boolean(
    input?.unifiedDiff?.trim()
    || input?.original?.trim()
    || input?.modified?.trim(),
  );
  return {
    hasTextPreview: hasText,
    pierreViewer: 'stub',
    note: hasText
      ? 'Showing unified/original+modified text. PierreDiff interactive viewer is Cap-only until a Lynx port exists.'
      : 'No diff text yet. PierreDiff viewer stub — host/Cap surface not wired in Lynx.',
  };
};

export const LYNX_PIERRE_DIFF_STUB_NOTES = [
  'Cap PierreDiffViewer + PIERRE_RUNTIME_BASE_CSS are web components — not claimed in Lynx.',
  'Lynx Changes sheet keeps real git file-diff / diff API text; polish is a labeled stub.',
] as const;
