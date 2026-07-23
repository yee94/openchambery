import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const titlebarSource = readFileSync(join(__dirname, '..', 'TitlebarLeftControls.tsx'), 'utf-8');
const sessionSidebarSource = readFileSync(join(__dirname, '..', '..', 'session', 'SessionSidebar.tsx'), 'utf-8');

describe('Electron global search placement', () => {
  test('renders global search beside a configured desktop brand outside the scroll region', () => {
    const brandHeaderIndex = sessionSidebarSource.indexOf('const desktopBrandHeader =');
    expect(brandHeaderIndex).toBeGreaterThan(-1);

    const brandHeaderSource = sessionSidebarSource.slice(brandHeaderIndex, brandHeaderIndex + 1_200);
    const brandIndex = brandHeaderSource.indexOf('<SidebarBrandMark className="min-w-0 flex-1" />');
    const searchIndex = brandHeaderSource.indexOf('<GlobalSearchButton className="ml-auto shrink-0" />');

    expect(brandHeaderSource).toContain('isDesktopShellRuntime && hasSidebarBrand');
    expect(brandHeaderSource).toContain('shrink-0');
    expect(brandHeaderSource).toContain('<div className="flex items-center justify-between">');
    expect(brandIndex).toBeGreaterThan(-1);
    expect(searchIndex).toBeGreaterThan(brandIndex);
    expect(searchIndex - brandIndex).toBeLessThan(200);

    // Fixed brand header is rendered above the scrollable projects list.
    const desktopBrandRenderIndex = sessionSidebarSource.indexOf('{desktopBrandHeader}');
    const projectsListIndex = sessionSidebarSource.indexOf('<SidebarProjectsList');
    expect(desktopBrandRenderIndex).toBeGreaterThan(-1);
    expect(projectsListIndex).toBeGreaterThan(desktopBrandRenderIndex);

    // Empty brand config must not reserve a desktop brand/search row in scroll content.
    const topContentIndex = sessionSidebarSource.indexOf('const topContent =');
    const topContentSource = sessionSidebarSource.slice(topContentIndex, topContentIndex + 1_200);
    expect(topContentSource).not.toContain('<GlobalSearchButton');
    expect(topContentSource).toContain('mobileVariant && hasSidebarBrand');
  });

  test('keeps the titlebar trigger for collapsed Electron sidebars and logo-less open sidebars', () => {
    expect(titlebarSource).toContain(
      'const showGlobalSearchInTitlebar = !isDesktopShellRuntime || !isSidebarOpen || !hasSidebarBrand;',
    );
    expect(titlebarSource).toContain(
      '{showGlobalSearchInTitlebar ? <GlobalSearchButton /> : null}',
    );
  });
});
