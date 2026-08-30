import { afterAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToString } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';

mock.module('@/components/ui/MobileResizableSheet', () => ({
  MobileResizableSheet: ({ children }: { children: React.ReactNode }) => children,
}));

const { MobileRowActionsSheet } = await import('./MobileRowActionsSheet');

afterAll(() => {
  mock.restore();
});

describe('MobileRowActionsSheet session actions', () => {
  test('renders Sync messages when the session callback is available', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileRowActionsSheet
          open
          target={{ kind: 'session', title: 'Session', pinned: false, shared: false }}
          actions={{ onRefreshTranscript: () => undefined }}
          onOpenChange={() => undefined}
        />
      </I18nProvider>,
    );

    expect(html).toContain('Sync messages');
  });
});

describe('MobileRowActionsSheet project actions', () => {
  test('renders Sync sessions when the project callback is available', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileRowActionsSheet
          open
          target={{ kind: 'project', title: 'OpenChamber', gitRepository: true }}
          actions={{ onSyncSessions: () => undefined }}
          onOpenChange={() => undefined}
        />
      </I18nProvider>,
    );

    expect(html).toContain('Sync sessions');
    expect(html).toContain('rounded-none');
    expect(html).toContain('supports-[corner-shape:squircle]:rounded-none');
    expect(html).toContain('data-mobile-press-feedback="none"');
    expect(html).toContain('data-page-scroll-lock="true"');
    expect(html).toContain('min-h-14');
    expect(html).toContain('leading-6');
  });
});

describe('MobileRowActionsSheet worktree actions', () => {
  test('renders the destructive action in a separate grouped card', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileRowActionsSheet
          open
          target={{ kind: 'worktree', title: 'ios-native' }}
          actions={{
            onNewSession: () => undefined,
            onDeleteWorktree: () => undefined,
          }}
          onOpenChange={() => undefined}
        />
      </I18nProvider>,
    );
    const container = document.createElement('div');
    container.innerHTML = html;
    const standardGroup = container.querySelector('[data-mobile-action-group="standard"]');
    const separatedGroup = container.querySelector('[data-mobile-action-group="separated"]');

    expect(container.querySelectorAll('[data-mobile-action-group]')).toHaveLength(2);
    expect(standardGroup?.querySelectorAll('button')).toHaveLength(1);
    expect(standardGroup?.textContent).toContain('New Session');
    expect(separatedGroup?.querySelectorAll('button')).toHaveLength(1);
    expect(separatedGroup?.textContent).toContain('Remove');
    expect(html).toContain('gap-5');
  });
});
