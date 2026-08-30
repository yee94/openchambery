import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  commitComposerAutocompleteRows,
  type ComposerAutocompleteListRow,
  type ComposerAutocompleteVisibleRows,
} from '@/lib/composer-autocomplete';

const mocks = vi.hoisted(() => {
  const commands: never[] = [];
  const skills: never[] = [];
  return {
    t: (key: string) => key,
    allowCommand: () => true,
    noop: () => undefined,
    noopSession: () => undefined,
    searchFiles: async () => [],
    getVisibleAgents: () => [],
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
  useConfigStore: (selector: (state: { getVisibleAgents: typeof mocks.getVisibleAgents }) => unknown) => selector({
    getVisibleAgents: mocks.getVisibleAgents,
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
    activeSessions: [],
  }),
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

    expect(container.textContent).toContain('/');
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

    expect(container.querySelector('[class*="z-[100]"]')).not.toBeNull();
    root.unmount();
  });
});
