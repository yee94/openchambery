import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { GitRemote } from '@/lib/gitApi';
import { SyncActions } from './SyncActions';

const remote: GitRemote = {
  name: 'origin',
  fetchUrl: 'https://example.com/repository.git',
  pushUrl: 'https://example.com/repository.git',
};

function renderSyncActions(aheadCount: number, behindCount: number) {
  return renderToStaticMarkup(
    <I18nProvider>
      <SyncActions
        syncAction={null}
        remotes={[remote]}
        onSync={() => undefined}
        disabled={false}
        aheadCount={aheadCount}
        behindCount={behindCount}
        trackingRemoteName="origin"
      />
    </I18nProvider>,
  );
}

describe('SyncActions', () => {
  test('keeps directional counts in the sync tooltip', () => {
    const markup = renderSyncActions(2, 3);

    expect(markup).toContain('aria-label="Sync Changes (3 down, 2 up)"');
    expect(markup).toContain('size-3.5 shrink-0');
    expect(markup).toContain('w-fit');
    expect(markup).toContain('bg-[var(--status-error)]');
    expect(markup).not.toContain('data-sync-direction=');
  });

  test('includes only the behind count in the tooltip when the branch is only behind', () => {
    const markup = renderSyncActions(0, 1);

    expect(markup).toContain('aria-label="Sync Changes (1 down, 0 up)"');
    expect(markup).not.toContain('data-sync-direction=');
  });

  test('includes only the ahead count in the tooltip when the branch is only ahead', () => {
    const markup = renderSyncActions(4, 0);

    expect(markup).toContain('aria-label="Sync Changes (0 down, 4 up)"');
    expect(markup).not.toContain('data-sync-direction=');
  });

  test('keeps the icon-only layout when the branch is synchronized', () => {
    const markup = renderSyncActions(0, 0);

    expect(markup).not.toContain('data-sync-direction=');
    expect(markup).toContain('oc-refresh');
    expect(markup).not.toContain('bg-[var(--status-error)]');
  });
});
