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
  test('shows directional ahead and behind counts with fixed-size icons', () => {
    const markup = renderSyncActions(2, 3);

    expect(markup).toContain('data-sync-direction="behind"');
    expect(markup).toContain('data-sync-direction="ahead"');
    expect(markup).toContain('>3</span>');
    expect(markup).toContain('>2</span>');
    expect(markup).toContain('oc-arrow-down');
    expect(markup).toContain('oc-arrow-up');
    expect(markup).toContain('size-3.5 shrink-0');
    expect(markup).not.toMatch(/<span[^>]*aria-hidden="true"[^>]*>5<\/span>/);
  });

  test('shows only the behind chip when the branch is only behind', () => {
    const markup = renderSyncActions(0, 1);

    expect(markup).toContain('data-sync-direction="behind"');
    expect(markup).toContain('>1</span>');
    expect(markup).not.toContain('data-sync-direction="ahead"');
  });

  test('shows only the ahead chip when the branch is only ahead', () => {
    const markup = renderSyncActions(4, 0);

    expect(markup).toContain('data-sync-direction="ahead"');
    expect(markup).toContain('>4</span>');
    expect(markup).not.toContain('data-sync-direction="behind"');
  });

  test('keeps the icon-only layout when the branch is synchronized', () => {
    const markup = renderSyncActions(0, 0);

    expect(markup).not.toContain('data-sync-direction=');
    expect(markup).toContain('oc-refresh');
  });
});
