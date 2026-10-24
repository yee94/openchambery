import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import fuzzysort from 'fuzzysort';

import {
  commitComposerAutocompleteRows,
  type ComposerAutocompleteListRow,
  type ComposerAutocompleteVisibleRows,
} from '@/lib/composer-autocomplete';

const mocks = vi.hoisted(() => {
  const commands: never[] = [];
  const skills: Array<{ name: string; scope: string; description?: string }> = [];
  const emptySessions: [] = [];
  return {
    emptySessions,
    t: (key: string) => key,
    allowCommand: () => true,
    noop: () => undefined,
    noopSession: () => undefined,
    searchFiles: async () => [],
    agents: [{ name: 'general', mode: 'subagent' }],
    commandQuery: { data: commands, isFetching: false },
    skillsQuery: { data: skills },
  };
});

vi.mock('@/sync/session-ui-store', () => {
  const state = {
    currentSessionId: 'ses_1',
    newSessionDraft: { open: false },
    getDirectoryForSession: () => '/repo',
  };
  return {
    useSessionUIStore: Object.assign(
      <T,>(selector: (value: typeof state) => T) => selector(state),
      { getState: () => state },
    ),
  };
});

vi.mock('@/sync/sync-context', () => ({
  useSessionMessages: () => [],
  useAllLiveSessions: () => mocks.emptySessions,
}));

vi.mock('@/queries/commandQueries', () => ({
  useCommandsQuery: () => mocks.commandQuery,
}));

vi.mock('@/queries/installedSkillsQueries', () => ({
  useInstalledSkillsQuery: () => mocks.skillsQuery,
}));

vi.mock('@/stores/useUIStore', () => ({
  useUIStore: (selector: (state: { isMobile: boolean }) => unknown) => selector({ isMobile: true }),
}));

vi.mock('./useMobileAutocompleteMaxHeight', () => ({
  useMobileAutocompleteMaxHeight: () => undefined,
  useMobileAutocompleteFixedBox: () => ({ left: 0, width: 320, bottom: 80, maxHeight: 200 }),
}));

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: mocks.t }),
}));

vi.mock('@/components/ui/ScrollableOverlay', () => ({
  ScrollableOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/hooks/useChatSearchDirectory', () => ({
  useChatSearchDirectory: () => '/repo',
}));

vi.mock('@/stores/useFileSearchStore', () => ({
  useFileSearchStore: (selector: (state: { searchFiles: typeof mocks.searchFiles }) => unknown) => selector({
    searchFiles: mocks.searchFiles,
  }),
}));

vi.mock('@/stores/useConfigStore', () => ({
  useConfigStore: (selector: (state: { agents: typeof mocks.agents }) => unknown) => selector({
    agents: mocks.agents,
  }),
}));

vi.mock('@/stores/useProjectsStore', () => ({
  useProjectsStore: (selector: (state: { activeProjectId: null; projects: [] }) => unknown) => selector({
    activeProjectId: null,
    projects: [],
  }),
}));

vi.mock('@/stores/useFilesViewTabsStore', () => ({
  useFilesViewTabsStore: (selector: (state: { byRoot: Record<string, never> }) => unknown) => selector({
    byRoot: {},
  }),
}));

vi.mock('@/stores/useGlobalSessionsStore', () => ({
  useGlobalSessionsStore: (selector: (state: { activeSessions: [] }) => unknown) => selector({
    activeSessions: mocks.emptySessions,
  }),
  mergeLiveSessionCatalog: (globalSessions: unknown[]) => globalSessions,
}));

vi.mock('@/lib/directoryShowHidden', () => ({
  useDirectoryShowHidden: () => false,
}));

vi.mock('@/lib/filesViewShowGitignored', () => ({
  useFilesViewShowGitignored: () => false,
}));

const loadCatalogs = () => Promise.all([
  import('./CommandAutocomplete'),
  import('./FileMentionAutocomplete'),
]);

afterEach(() => {
  document.body.innerHTML = '';
});

const flush = async (root: ReturnType<typeof createRoot>, node: React.ReactNode) => {
  await act(async () => {
    root.render(node);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const AlwaysCopyHost = ({
  children,
}: {
  children: (args: {
    onRowsChange: (payload: ComposerAutocompleteVisibleRows) => void;
    rows: ComposerAutocompleteListRow[];
  }) => React.ReactNode;
}) => {
  const [rows, setRows] = React.useState<ComposerAutocompleteListRow[]>([]);
  const [highlight, setHighlight] = React.useState(0);
  const renders = React.useRef(0);
  const onRowsChange = React.useRef((payload: ComposerAutocompleteVisibleRows) => {
    setRows((previous) => commitComposerAutocompleteRows(previous, payload.rows));
    setHighlight((previous) => (
      previous === payload.highlightedIndex ? previous : payload.highlightedIndex
    ));
  }).current;
  renders.current += 1;
  if (renders.current > 25) {
    throw new Error(`Maximum update depth exceeded (${renders.current} host renders)`);
  }
  return (
    <div data-highlight={highlight} data-count={rows.length} data-renders={renders.current}>
      {children({
        rows,
        onRowsChange,
      })}
    </div>
  );
};

const UnstablePolicyChild = ({
  onRowsChange,
  policy,
}: {
  onRowsChange: (payload: ComposerAutocompleteVisibleRows) => void;
  policy: (name: string) => boolean;
}) => {
  const [names, setNames] = React.useState<string[]>([]);
  React.useEffect(() => {
    setNames(['new', 'undo', 'model'].filter(policy));
  }, [policy]);
  React.useEffect(() => {
    onRowsChange({
      rows: names.map((name) => ({
        id: name,
        title: `/${name}`,
        iconName: 'command',
      })),
      highlightedIndex: 0,
    });
  }, [names, onRowsChange]);
  return <div>{names.map((name) => `/${name}`).join(' ')}</div>;
};

describe('native composer autocomplete JS channel', () => {
  test('does not rerank 300 skills for 50 unrelated updates, and sees a refreshed agent catalog', async () => {
    mocks.skillsQuery.data = Array.from({ length: 300 }, (_, i) => ({ name: `generator-${i}`, scope: 'user' }));
    const originalAgents = mocks.agents;
    const [, { FileMentionAutocomplete }] = await loadCatalogs();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const rank = vi.spyOn(fuzzysort, 'go');
    const render = (tick: number) => <div data-tick={tick}><FileMentionAutocomplete
      searchQuery="gene" onFileSelect={mocks.noop} onAgentSelect={mocks.noop}
      onSkillSelect={mocks.noop} onClose={mocks.noop}
    /></div>;
    try {
      await flush(root, render(0));
      rank.mockClear();
      for (let i = 1; i <= 50; i++) await flush(root, render(i));
      expect(rank).not.toHaveBeenCalled();
      expect(document.body.querySelectorAll('[data-mention-id]')).toHaveLength(10);
      mocks.agents = [{ name: 'gene', mode: 'subagent' }];
      await flush(root, render(51));
      expect(document.body.querySelector('[data-mention-id]')?.getAttribute('data-mention-id')).toBe('agent:gene');
      expect(rank).toHaveBeenCalledTimes(1);
    } finally {
      rank.mockRestore();
      root.unmount();
      mocks.skillsQuery.data = [];
      mocks.agents = originalAgents;
    }
  });

  test('ranks the closest agent before skills in one flat keyboard/native list', async () => {
    mocks.skillsQuery.data = [
      { name: 'gpt-image-generator', scope: 'user' },
      { name: 'poe-image-generator', scope: 'user' },
      { name: 'comic-illustration', scope: 'user', description: 'generate images' },
    ];
    const [, { FileMentionAutocomplete }] = await loadCatalogs();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const ref = React.createRef<import('./FileMentionAutocomplete').FileMentionHandle>();
    const onAgentSelect = vi.fn();
    const onSkillSelect = vi.fn();
    const onRowsChange = vi.fn();
    const picker = () => <FileMentionAutocomplete
      ref={ref}
      searchQuery="gene"
      onFileSelect={mocks.noop}
      onAgentSelect={onAgentSelect}
      onSkillSelect={onSkillSelect}
      onClose={mocks.noop}
      onRowsChange={onRowsChange}
    />;
    try {
      await flush(root, picker());
      const rows = onRowsChange.mock.lastCall?.[0].rows as ComposerAutocompleteListRow[];
      expect(rows[0]?.title).toBe('@general');
      expect(rows.map((row) => row.title)).not.toContain('@comic-illustration');
      expect(document.body.textContent).not.toContain('chat.fileMentionAutocomplete.groups.');
      expect(document.body.querySelector('[data-agent-avatar]')).not.toBeNull();
      await act(async () => ref.current?.handleKeyDown('Enter'));
      expect(onAgentSelect).toHaveBeenCalledWith('general');
      await act(async () => ref.current?.acceptIndex(1));
      expect(onSkillSelect.mock.lastCall?.[0].name).toBe(rows[1]?.title.slice(1));
      await act(async () => {
        ref.current?.handleKeyDown('ArrowDown');
        ref.current?.handleKeyDown('Tab');
      });
      expect(onSkillSelect.mock.lastCall?.[0].name).toBe(rows[1]?.title.slice(1));
      mocks.skillsQuery.data = [{ name: 'gene', scope: 'user' }, ...mocks.skillsQuery.data];
      await flush(root, picker());
      await act(async () => ref.current?.handleKeyDown('Tab'));
      expect(onSkillSelect.mock.lastCall?.[0].name).toBe(rows[1]?.title.slice(1));
    } finally {
      root.unmount();
      mocks.skillsQuery.data = [];
    }
  });
  test('unstable policy plus equal-row commit does not overflow React updates', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await flush(root, (
      <AlwaysCopyHost>
        {({ onRowsChange }) => (
          <UnstablePolicyChild
            policy={() => true}
            onRowsChange={onRowsChange}
          />
        )}
      </AlwaysCopyHost>
    ));

    expect(container.textContent).toContain('/new');
    expect(container.querySelector('[data-renders]')?.getAttribute('data-renders')).not.toBe('25');
    root.unmount();
  });

  test('slash catalog can emit rows to a parent without overflowing React updates', async () => {
    const [{ CommandAutocomplete }] = await loadCatalogs();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await flush(root, (
      <AlwaysCopyHost>
        {({ onRowsChange }) => (
          <CommandAutocomplete
            searchQuery=""
            onCommandSelect={mocks.noop}
            onClose={mocks.noop}
            commandPolicy={mocks.allowCommand}
            commandContext={{ sessionID: 'ses_1', hasMessages: true, hasNewDraft: false }}
            onRowsChange={onRowsChange}
          />
        )}
      </AlwaysCopyHost>
    ));

    expect(document.body.textContent).toContain('/');
    expect(Number(container.querySelector('[data-count]')?.getAttribute('data-count'))).toBeGreaterThan(0);
    root.unmount();
  });

  test('mention catalog can emit rows to a parent without overflowing React updates', async () => {
    const [, { FileMentionAutocomplete }] = await loadCatalogs();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await flush(root, (
      <AlwaysCopyHost>
        {({ onRowsChange }) => (
          <FileMentionAutocomplete
            searchQuery=""
            onFileSelect={mocks.noop}
            onAgentSelect={mocks.noop}
            onSessionSelect={mocks.noopSession}
            onClose={mocks.noop}
            onRowsChange={onRowsChange}
          />
        )}
      </AlwaysCopyHost>
    ));

    expect(document.body.querySelector('[class*="z-[100]"]')).not.toBeNull();
    expect(container.querySelector('[data-renders]')?.getAttribute('data-renders')).not.toBe('25');
    root.unmount();
  });

  test('mobile skill rows show a highlighted subtitle smaller than the title', async () => {
    mocks.skillsQuery.data = [{
      name: 'paint',
      scope: 'user',
      description: 'paint with an image model',
    }];
    const [, { FileMentionAutocomplete }] = await loadCatalogs();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await flush(root, (
      <FileMentionAutocomplete
        searchQuery="paint"
        onFileSelect={mocks.noop}
        onSkillSelect={mocks.noop}
        onClose={mocks.noop}
      />
    ));

    const subtitle = document.body.querySelector('.typography-micro');
    expect(subtitle?.textContent).toBe('paint with an image model');
    expect(subtitle?.querySelector('mark')?.textContent).toBe('paint');
    expect(subtitle?.className).toContain('typography-micro');
    expect(subtitle?.className).not.toContain('typography-meta');
    root.unmount();
    mocks.skillsQuery.data = [];
  });
});
