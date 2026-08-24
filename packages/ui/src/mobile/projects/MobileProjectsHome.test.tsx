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
  pinnedSessions: [{
    id: 'global-pinned-session',
    kind: 'pagination',
    title: 'Global pinned session',
    subtitle: 'OpenChamber',
    pinned: true,
  }],
  onAddProject: noop,
  onNewSession: noop,
  onToggleProject: noop,
  onOpenProjectActions: noop,
  onToggleWorktree: noop,
  onNewWorktreeSession: noop,
  onOpenWorktreeActions: noop,
  onDeleteWorktree: noop,
  onSelectSession: noop,
  onPinSession: noop,
  onArchiveSession: noop,
  onOpenSessionActions: noop,
};

describe('MobileProjectsHome workspace groups', () => {
  test('renders one global pinned project card before projects', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileProjectsHome {...props} />
      </I18nProvider>,
    );

    expect(html).toContain('Global pinned session');
    expect(html).toContain('OpenChamber');
    expect(html).toContain('oc-mobile-project-shell');
    expect(html.indexOf('Global pinned session')).toBeLessThan(html.indexOf('Main session'));
    expect(html.match(/aria-label="Pinned"/g)).toHaveLength(1);
    expect(html).toContain('oc-mobile-project-card');
  });

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
    // Worktree name is secondary to the project title — not the same
    // semibold ui-label treatment, or it visually outranks the project.
    expect(html).toMatch(/oc-mobile-entity-title[^"]*font-semibold[^"]*text-foreground[^>]*>Feature branch/);
  });

  test('wires worktree action affordances on linked worktree headers', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileProjectsHome {...props} />
      </I18nProvider>,
    );

    // Swipe rail + trailing overflow menu (session-row parity; no always-on +).
    expect(html).toContain('oc-mobile-worktree-actions');
    expect(html).toContain('oc-mobile-worktree-more');
    expect(html).toContain('oc-mobile-worktree-label-trigger');
    expect(html).not.toContain('oc-mobile-worktree-new-session');
  });
});
