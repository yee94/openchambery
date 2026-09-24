import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { PermissionRequest } from '@/types/permission';

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: (selector: (state: { currentSessionId: string }) => unknown) => selector({ currentSessionId: 'ses_current' }),
}));

mock.module('@/sync/sync-context', () => ({
  useSessions: () => [],
}));

mock.module('@/sync/session-actions', () => ({
  respondToPermission: async () => undefined,
}));

mock.module('@/components/code/WorkerHighlightedCode', () => ({
  WorkerHighlightedCode: ({ code }: { code: string }) => <pre>{code}</pre>,
}));

mock.module('./DiffPreview', () => ({
  DiffPreview: () => null,
  WritePreview: () => null,
}));

const { PermissionCard } = await import('./PermissionCard');

const permission: PermissionRequest = {
  id: 'perm_external_directory',
  sessionID: 'ses_current',
  permission: 'external_directory',
  patterns: ['/Library/Logs/DiagnosticReports/*'],
  metadata: {
    filepath: '/Library/Logs/DiagnosticReports',
    parentDir: '/Library/Logs',
  },
  always: ['/Library/Logs/DiagnosticReports/*'],
};

describe('PermissionCard', () => {
  test('renders metadata as fields and keeps the always action compact', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <PermissionCard permission={permission} />
      </I18nProvider>,
    );

    expect(markup).toContain('File Path');
    expect(markup).toContain('Parent Directory');
    expect(markup).toContain('data-interaction-card');
    expect(markup).not.toContain('&quot;filepath&quot;');
    expect(markup).toContain('grid-cols-1');
    expect(markup).toContain('sm:flex');

    const alwaysButton = markup.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Always agree(?:(?!<\/button>)[\s\S])*<\/button>/)?.[0];
    expect(alwaysButton).toBeDefined();
    expect(alwaysButton).toContain('#oc-arrow-right');
    expect(alwaysButton).toContain('var(--status-success)');
    expect(alwaysButton).not.toContain('/Library/Logs');
  });
});
