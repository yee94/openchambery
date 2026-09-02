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
    expect(html.match(/aria-label="Pinned \/ In progress"/g)).toHaveLength(1);
    expect(html).toContain('oc-mobile-project-card');
  });

  test('groups pinned sessions above in-progress sessions without extra labels', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileProjectsHome
          {...props}
          inProgressSessions={[{
            id: 'running-session',
            kind: 'pagination',
            title: 'Running session',
            subtitle: 'OpenChamber',
          }]}
        />
      </I18nProvider>,
    );

    expect(html.indexOf('Global pinned session')).toBeLessThan(html.indexOf('Running session'));
    expect(html.indexOf('Running session')).toBeLessThan(html.indexOf('Main session'));
  });

  test('still renders the attention card when only in-progress sessions exist', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileProjectsHome
          {...props}
          pinnedSessions={[]}
          inProgressSessions={[{
            id: 'unread-session',
            kind: 'pagination',
            title: 'Unread session',
            unread: true,
          }]}
        />
      </I18nProvider>,
    );

    expect(html).toContain('Unread session');
    expect(html).toContain('aria-label="Pinned / In progress"');
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
