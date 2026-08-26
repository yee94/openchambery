import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

import { I18nProvider } from '@/lib/i18n';
import type { GitStatus } from '@/lib/api/types';

import { ChangesPanel, type ChangesGroupConfig } from './ChangesPanel';

vi.mock('@/stores/useUIStore', () => ({
  useUIStore: (
    selector: (state: {
      gitChangesViewMode: 'flat' | 'tree';
      setGitChangesViewMode: (mode: 'flat' | 'tree') => void;
    }) => unknown,
  ) =>
    selector({
      gitChangesViewMode: 'flat',
      setGitChangesViewMode: () => undefined,
    }),
}));

const file = (path: string): GitStatus['files'][number] => ({
  path,
  index: ' ',
  working_dir: 'M',
});

function createGroup(entries: GitStatus['files']): ChangesGroupConfig {
  return {
    id: 'unstaged',
    title: 'Changes',
    entries,
    actionSymbol: '+',
    actionAllLabel: 'Stage all',
    getActionLabel: (path) => `Stage ${path}`,
    onActionFile: () => undefined,
    onActionAll: () => undefined,
    onViewDiff: () => undefined,
    onRevertFile: () => undefined,
  };
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof ChangesPanel>> = {}) {
  return renderToStaticMarkup(
    <I18nProvider>
      <ChangesPanel
        groups={[createGroup([file('src/app.ts')])]}
        diffStats={undefined}
        revertingPaths={new Set()}
        onRevertAll={() => undefined}
        {...overrides}
      />
    </I18nProvider>,
  );
}

describe('ChangesPanel revert all', () => {
  test('puts the revert-all icon in the header rail before the file list', () => {
    const markup = renderPanel({
      headerLeadingActions: <span>leading-action</span>,
      headerActions: <span>sync-action</span>,
    });
    const leadingIndex = markup.indexOf('leading-action');
    const revertIndex = markup.indexOf('aria-label="Revert all"');
    const syncIndex = markup.indexOf('sync-action');
    const listIndex = markup.indexOf('Changed files');

    expect(revertIndex).toBeGreaterThan(-1);
    expect(leadingIndex).toBeGreaterThan(revertIndex);
    expect(syncIndex).toBeGreaterThan(leadingIndex);
    expect(listIndex).toBeGreaterThan(syncIndex);
  });

  test('hides revert all when the handler is omitted', () => {
    const markup = renderPanel({ onRevertAll: undefined });

    expect(markup).not.toContain('aria-label="Revert all"');
    expect(markup).toContain('src/app.ts');
  });

  test('disables revert all while a bulk revert is in flight', () => {
    const markup = renderPanel({ isRevertingAll: true });

    expect(markup).toMatch(/disabled(?=[^>]*aria-label="Revert all")|(?=aria-label="Revert all"[^>]*disabled)/);
  });
});
