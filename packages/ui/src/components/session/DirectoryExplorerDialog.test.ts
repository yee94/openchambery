import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDirectoryExplorerMobileLayout } from './directoryExplorerLayout';

const componentSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'DirectoryExplorerDialog.tsx'),
  'utf8',
);

describe('DirectoryExplorerDialog mobile layout', () => {
  test('uses device detection when forceMobile is undefined', () => {
    expect(resolveDirectoryExplorerMobileLayout(undefined, true)).toBe(true);
    expect(resolveDirectoryExplorerMobileLayout(undefined, false)).toBe(false);
  });

  test('uses forceMobile when supplied', () => {
    expect(resolveDirectoryExplorerMobileLayout(true, false)).toBe(true);
    expect(resolveDirectoryExplorerMobileLayout(false, true)).toBe(false);
  });

  // Controlled-sheet contract (see components/ui/DOCUMENTATION.md): the mobile
  // sheet must pass the real controlled `open={open}` value. A bare `open`
  // attribute stays true through the post-dismiss reconcile frame and makes
  // the sheet flash back up after a gesture dismiss.
  test('mobile sheet stays controlled through the real open prop', () => {
    expect(componentSource).toContain('<MobileResizableSheet');
    expect(componentSource).toContain('open={open}');
    expect(componentSource).not.toMatch(/<MobileResizableSheet[^>]*\bopen\s*\n/);
  });

  test('keeps the show-hidden action in the mobile sheet header', () => {
    expect(componentSource).toContain('trailing={showHiddenToggle}');
    expect(componentSource).not.toContain('<div className="flex shrink-0 justify-end px-3">{showHiddenToggle}</div>');
    expect(componentSource).toContain('{showHiddenToggle}\n          </div>');
  });
});
