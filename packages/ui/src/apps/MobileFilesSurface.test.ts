import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'MobileFilesSurface.tsx'), 'utf-8');

describe('MobileFilesSurface html preview', () => {
  test('renders html files in a sandboxed fs/serve webview', () => {
    expect(source).toContain('const MobileHtmlPreview');
    expect(source).toContain("sandbox=\"allow-scripts allow-same-origin allow-forms\"");
    expect(source).toContain('/api/fs/serve');
    expect(source).toContain('isHtmlFile(path)');
    expect(source).toContain("!isHtmlFile(filePath) || htmlViewMode === 'source'");
  });

  test('loads html through runtimeFetch on relay instead of iframe src', () => {
    expect(source).toContain('isRelayModeActive()');
    expect(source).toContain('runtimeFetch(toFsServeRoutePath(path))');
    expect(source).toContain('srcDoc={relay ? relaySrcDoc : undefined}');
  });

  test('offers source toggle and a fullscreen overlay with back', () => {
    expect(source).toContain("htmlViewMode === 'source'");
    expect(source).toContain('mobile.files.html.fullscreenAria');
    expect(source).toContain('mobile.files.html.exitFullscreenAria');
    expect(source).toContain('mobile.files.html.viewSourceAria');
    expect(source).toContain("id: 'mobile-html-fullscreen'");
    expect(source).toContain('createPortal(htmlViewer, document.body)');
    expect(source).toContain('name="fullscreen"');
    expect(source).toContain("'file-code'");
    expect(source).toContain('attachIframeSheetOverscroll(iframe)');
  });
});
