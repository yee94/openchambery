/**
 * Cap MobileFilesSurface HTML preview — honest Lynx stub.
 *
 * Cap uses an iframe + `data-mobile-html-preview` edge-to-edge CSS.
 * Lynx has no WebView iframe surface yet; until the host provides a
 * WKWebView / WebView sheet, we classify HTML and fall back to text preview
 * with an explicit note — never fake a rendered DOM.
 *
 * Source: packages/ui/src/apps/MobileFilesSurface.tsx
 */

export type LynxHtmlPreviewMode = 'text' | 'html-stub' | 'unsupported';

export type LynxHtmlPreviewPlan =
  | {
      mode: 'html-stub';
      /** Honest: host must open a native WebView sheet; Lynx shows text fallback. */
      hostRequired: true;
      note: string;
      textFallback: true;
    }
  | { mode: 'text'; textFallback: true }
  | { mode: 'unsupported'; reason: string };

const HTML_EXT = /\.(html?|xhtml)$/i;

export const isLynxHtmlPath = (path: string | null | undefined): boolean => {
  const trimmed = path?.trim() ?? '';
  if (!trimmed) return false;
  const base = trimmed.split(/[?#]/)[0] ?? trimmed;
  return HTML_EXT.test(base);
};

export const planLynxHtmlPreview = (path: string | null | undefined): LynxHtmlPreviewPlan => {
  if (!isLynxHtmlPath(path)) {
    return { mode: 'text', textFallback: true };
  }
  return {
    mode: 'html-stub',
    hostRequired: true,
    textFallback: true,
    note: 'Cap MobileFilesSurface uses iframe + sandbox=allow-scripts allow-same-origin allow-forms + data-mobile-html-preview. Lynx has no iframe yet — text/source only until host WKWebView/WebView sheet. Do not claim rendered HTML preview.',
  };
};

export const LYNX_HTML_PREVIEW_STUB_NOTES = [
  'Cap: data-mobile-html-preview + iframe; Lynx: labeled text stub until host WebView.',
  'Never invent a Lynx DOM iframe or claim edge-to-edge HTML chrome without host.',
] as const;
