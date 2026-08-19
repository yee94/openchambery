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
  });
});
