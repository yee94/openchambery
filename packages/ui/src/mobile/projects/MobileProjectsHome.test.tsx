import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToString } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';

import {
  MobileProjectsHome,
  type MobileProjectHomeItem,
  type MobileProjectsHomeProps,
} from './MobileProjectsHome';

const noop = () => undefined;

const projects: MobileProjectHomeItem[] = [{
  id: 'project-1',
  name: 'OpenChamber',
  path: '/code/openchamber',
  sessionCount: 2,
  expanded: true,
  worktrees: [{
    id: 'main',
    name: 'Main workspace',
    path: '/code/openchamber',
    kind: 'main',
    sessionCount: 1,
    sessions: [{ id: 'main-session', kind: 'pagination', title: 'Main session' }],
  }, {
    id: 'feature',
    name: 'Feature branch',
    path: '/code/openchamber-feature',
    kind: 'worktree',
    sessionCount: 1,
    expanded: true,
    sessions: [{ id: 'feature-session', kind: 'pagination', title: 'Feature session' }],
  }],
}];

const props: MobileProjectsHomeProps = {
  projects,
  onAddProject: noop,
  onNewSession: noop,
  onToggleProject: noop,
  onOpenProjectActions: noop,
  onToggleWorktree: noop,
  onSelectSession: noop,
  onPinSession: noop,
  onArchiveSession: noop,
  onOpenSessionActions: noop,
};

describe('MobileProjectsHome workspace groups', () => {
  test('renders main sessions directly and keeps linked worktree headers', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileProjectsHome {...props} />
      </I18nProvider>,
    );

    expect(html).toContain('Main session');
    expect(html).not.toContain('Main workspace');
    expect(html).toContain('Feature branch');
    expect(html).toContain('Feature session');
  });
});
