/**
 * Cap PierreDiffViewer — Lynx feature path + portable text (not Pierre runtime).
 *
 * Cap Changes / Files mount `@/components/views/PierreDiffViewer` which imports
 * `FileDiff` / `VirtualizedFileDiff` from `@pierre/diffs` (monorepo:
 * `packages/ui` → `@pierre/diffs@1.3.0-beta.6`) and injects
 * `PIERRE_RUNTIME_BASE_CSS` into Pierre's **Shadow DOM**.
 *
 * Investigation (do not invent APIs / fake CSS·iframe success):
 * - React `FileDiff` renders custom element `diffs-container` (`DIFFS_TAG_NAME`).
 * - Core component uses `attachShadow`, `document.createElement`, `HTMLElement`,
 *   and CSS style nodes inside `shadowRoot`.
 * - Peer deps: `react` + **`react-dom`**. Lynx uses `@lynx-js/react` / rspeedy
 *   engine 3.8 — no DOM custom elements, no Shadow DOM, no react-dom host.
 * - `@pierre/diffs/ssr` can emit HTML strings (`preloadDiffHTML` / `renderHTML`),
 *   but mounting that HTML still needs a browser/WebView host. Lynx Files HTML
 *   path is already an honest text stub until host WKWebView — same rule here.
 * - Cap also uses `DiffWorkerProvider` worker pool — Cap/web only.
 *
 * Therefore the feature path always activates **portable-text** (or none).
 * `preferPierre` is accepted so callers can request Cap parity; it never
 * switches Lynx onto a fake Pierre viewer.
 *
 * Source: packages/ui/src/apps/MobileChangesSurface.tsx,
 *         packages/ui/src/components/views/PierreDiffViewer.tsx,
 *         packages/ui/node_modules/@pierre/diffs
 */

export type LynxPierreDiffLineKind =
  | 'add'
  | 'del'
  | 'context'
  | 'hunk'
  | 'meta'
  | 'empty';

export type LynxPierreDiffLine = {
  kind: LynxPierreDiffLineKind;
  text: string;
};

export type LynxPierreDiffStats = {
  insertions: number;
  deletions: number;
};

export type LynxPierreViewerState = 'unavailable';

export type LynxPierreDiffPresentation = 'portable-text' | 'none';

export type LynxPierreDiffPlan = {
  /** Real file/turn diff text is available from Cap APIs. */
  hasTextPreview: boolean;
  /** Cap `@pierre/diffs` interactive viewer — blocked on Lynx (see blockers). */
  pierreViewer: LynxPierreViewerState;
  /** Portable Lynx presentation of Cap git text (not Pierre chrome). */
  presentation: LynxPierreDiffPresentation;
  note: string;
  lines: LynxPierreDiffLine[];
  stats: LynxPierreDiffStats;
};

/**
 * Honest blockers — Cap `@pierre/diffs` cannot run in Lynx/rspeedy without a
 * DOM/WebView host. Do not treat these as TODOs to paper over with CSS.
 */
export const LYNX_PIERRE_DIFF_BLOCKERS = [
  'Cap @pierre/diffs FileDiff mounts custom element diffs-container with Shadow DOM (attachShadow) + document.createElement + HTMLElement.',
  'Peer deps require react-dom; Lynx uses @lynx-js/react without a DOM custom-element host.',
  'Cap PIERRE_RUNTIME_BASE_CSS is injected into Shadow DOM — no Lynx equivalent.',
  'SSR preloadDiffHTML / renderHTML still need a browser/WebView to display — do not fake iframe success.',
  'Cap DiffWorkerProvider worker pool is web-only.',
] as const;

/** @deprecated alias — kept for prior exports; same as LYNX_PIERRE_DIFF_BLOCKERS. */
export const LYNX_PIERRE_DIFF_STUB_NOTES = LYNX_PIERRE_DIFF_BLOCKERS;

/**
 * Cap ChangeRow measurable spacing (packages/ui/.../git/ChangeRow.tsx):
 * - action button `size-6` → 24px
 * - content `gap-1.5` → 6px
 * - stats slash `mx-0.5` → 2px
 * - row `h-8` → 32px min height
 * - trailing `auto-cols-[1.5rem]` → 24px columns, no extra marginLeft
 * - status code `w-3.5` → 14px
 */
export const LYNX_CHANGE_ROW_SPACING = {
  actionSizePx: 24,
  contentGapPx: 6,
  statsSlashMarginPx: 2,
  rowMinHeightPx: 32,
  rowPaddingYPx: 4,
  /** Cap trailing action grid has no marginLeft; Lynx single chip uses 0. */
  chipMarginLeftPx: 0,
  statusCodeWidthPx: 14,
} as const;

export type LynxPierreDiffFeatureResolution = {
  /** Caller request — Cap parity asks for pierre. */
  requested: 'pierre' | 'portable';
  /** What Lynx actually mounts. */
  active: 'portable-text';
  pierreViewer: LynxPierreViewerState;
  reason: string;
  blockers: readonly string[];
};

/**
 * Feature path: Cap Pierre viewer vs portable text.
 * Even when `preferPierre` is true, Lynx stays on portable-text and records
 * the honest blocker — never invents Pierre CSS / iframe / worker success.
 */
export const resolveLynxPierreDiffFeature = (options?: {
  preferPierre?: boolean;
}): LynxPierreDiffFeatureResolution => {
  const preferPierre = options?.preferPierre === true;
  return {
    requested: preferPierre ? 'pierre' : 'portable',
    active: 'portable-text',
    pierreViewer: 'unavailable',
    reason: preferPierre
      ? 'Requested Cap @pierre/diffs; Lynx cannot host diffs-container Shadow DOM / react-dom — portable text only.'
      : 'Portable text path (Cap git file-diff / diff APIs). Cap @pierre/diffs not hostable in Lynx.',
    blockers: LYNX_PIERRE_DIFF_BLOCKERS,
  };
};

/** Cap-style unified-diff line classification (JS-portable; no Pierre). */
export const parseLynxUnifiedDiffLines = (unifiedDiff: string | null | undefined): LynxPierreDiffLine[] => {
  const raw = unifiedDiff ?? '';
  if (!raw.length) return [];
  return raw.split('\n').map((text) => {
    if (text.length === 0) return { kind: 'empty' as const, text };
    if (text.startsWith('+++') || text.startsWith('---') || text.startsWith('diff ') || text.startsWith('index ')) {
      return { kind: 'meta' as const, text };
    }
    if (text.startsWith('@@')) return { kind: 'hunk' as const, text };
    if (text.startsWith('+')) return { kind: 'add' as const, text };
    if (text.startsWith('-')) return { kind: 'del' as const, text };
    return { kind: 'context' as const, text };
  });
};

export const summarizeLynxDiffStats = (lines: readonly LynxPierreDiffLine[]): LynxPierreDiffStats => {
  let insertions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.kind === 'add') insertions += 1;
    else if (line.kind === 'del') deletions += 1;
  }
  return { insertions, deletions };
};

/**
 * Build original+modified portable preview when unified is missing but Cap
 * file-diff returned both sides (MobileChangesSurface spirit).
 */
export const buildLynxOriginalModifiedPreview = (
  path: string,
  original: string | null | undefined,
  modified: string | null | undefined,
): string => {
  const file = path.trim() || 'file';
  const before = (original ?? '').split('\n');
  const after = (modified ?? '').split('\n');
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ preview @@',
    ...before.map((line) => `-${line}`),
    ...after.map((line) => `+${line}`),
  ].join('\n');
};

export const planLynxPierreDiff = (input?: {
  unifiedDiff?: string | null;
  original?: string | null;
  modified?: string | null;
  binary?: boolean;
  path?: string | null;
  /** When true, records Cap Pierre request but still activates portable-text. */
  preferPierre?: boolean;
}): LynxPierreDiffPlan => {
  const feature = resolveLynxPierreDiffFeature({ preferPierre: input?.preferPierre });

  if (input?.binary) {
    return {
      hasTextPreview: false,
      pierreViewer: feature.pierreViewer,
      presentation: 'none',
      note: 'Binary file — no PierreDiff / text preview.',
      lines: [],
      stats: { insertions: 0, deletions: 0 },
    };
  }

  let unified = input?.unifiedDiff?.trim() ? input.unifiedDiff : null;
  if (!unified && (input?.original?.length || input?.modified?.length)) {
    unified = buildLynxOriginalModifiedPreview(
      input?.path ?? 'file',
      input?.original,
      input?.modified,
    );
  }

  const lines = parseLynxUnifiedDiffLines(unified);
  const stats = summarizeLynxDiffStats(lines);
  const hasText = lines.length > 0;

  return {
    hasTextPreview: hasText,
    pierreViewer: feature.pierreViewer,
    presentation: hasText ? 'portable-text' : 'none',
    note: hasText
      ? `Portable text diff (line kinds + stats). ${feature.reason}`
      : `No diff text yet. ${feature.reason}`,
    lines,
    stats,
  };
};

/**
 * Cap-like portable line colors (ChangeRow A/D spirit) — not Pierre CSS.
 * add → status.success (green); del → status.error (red); hunk/meta stay muted
 * so deletions are distinguishable from hunk headers.
 */
export const lynxPierreDiffLineToken = (
  kind: LynxPierreDiffLineKind,
): 'status.success' | 'status.error' | 'surface.mutedForeground' | 'surface.foreground' => {
  switch (kind) {
    case 'add':
      return 'status.success';
    case 'del':
      return 'status.error';
    case 'hunk':
    case 'meta':
    case 'empty':
      return 'surface.mutedForeground';
    case 'context':
    default:
      return 'surface.foreground';
  }
};

/**
 * Cap ChangeRow status letter from git index / working_dir / status string.
 * Source: packages/ui/src/components/views/git/ChangeRow.tsx CHANGE_DESCRIPTORS.
 */
export const lynxChangeStatusCode = (status: string | null | undefined): string => {
  const raw = (status ?? '').trim();
  if (!raw) return 'M';
  const first = raw.charAt(0).toUpperCase();
  if (first === '?' || first === 'A' || first === 'D' || first === 'R' || first === 'C' || first === 'M') {
    return first === '?' ? '?' : first;
  }
  const lower = raw.toLowerCase();
  if (lower.includes('untracked') || lower === '?') return '?';
  if (lower.includes('add') || lower === 'staged' || lower.includes('new')) return 'A';
  if (lower.includes('delet')) return 'D';
  if (lower.includes('renam')) return 'R';
  if (lower.includes('cop')) return 'C';
  return 'M';
};

export const lynxChangeStatusToken = (
  code: string,
): 'status.success' | 'status.error' | 'primary.base' | 'surface.mutedForeground' => {
  switch (code) {
    case 'A':
      return 'status.success';
    case 'D':
      return 'status.error';
    case '?':
    case 'R':
    case 'C':
      return 'primary.base'; // Cap --status-info spirit (no Lynx status.info token)
    case 'M':
    default:
      return 'surface.mutedForeground'; // Cap --status-warning closest portable stand-in
  }
};
