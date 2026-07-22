import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionWorktreeStore } from './session-worktree-store';
import {
  beginDraftEstablishingPaint,
  clearDraftEstablishingPaint,
  materializeOpenDraftSession,
  routeMessage,
  useSessionUIStore,
} from './session-ui-store';
import { setActionRefs, setOptimisticRefs } from './session-actions';
import { setSyncRefs } from './sync-refs';
import { queryClient } from '@/lib/queryRuntime';
import { commandQueryOptions } from '@/queries/commandQueries';
import { installedSkillsQueryOptions } from '@/queries/installedSkillsQueries';
import { useConfigStore } from '@/stores/useConfigStore';
import { useInputStore } from './input-store';
import { newSessionDraftKey, sessionDraftKey } from './input-draft-types';
import { queueScopeKey } from '@/stores/messageQueueStore';

/**
 * Unit tests for session worktree routing through the authoritative store.
 *
 * These tests verify that session-worktree-store is properly integrated as the
 * authoritative holder of session↔worktree attachments, and that session-ui-store
 * routes through it for switching and creation flows.
 *
 * Note: Full integration tests for setCurrentSession require runtime mocking.
 * These tests focus on the contract layer: that setAttachment/getAttachment work
 * correctly and that the contract helpers produce correct results.
 */

describe('session-worktree-store worktree routing', () => {
  beforeEach(() => {
    // Clear all attachments before each test
    const store = useSessionWorktreeStore.getState();
    const attachments = store.attachments;
    for (const sessionId of attachments.keys()) {
      store.clearAttachment(sessionId);
    }
    useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, worktreeMetadata: new Map() });
    useGlobalSessionsStore.setState({ activeSessions: [], archivedSessions: [] });
    setSyncRefs(opencodeClient, { children: new Map(), getState: () => undefined }, '');
  });

  test('getAuthoritativeDirectoryForSession excludes the current-session fallback', () => {
    useSessionUIStore.setState({
      currentSessionId: 'session-fallback',
      currentSessionDirectory: '/fallback/directory',
    });

    expect(useSessionUIStore.getState().getAuthoritativeDirectoryForSession('session-fallback')).toBeNull();
  });

  test('getAuthoritativeDirectoryForSession resolves worktree metadata', () => {
    useSessionUIStore.setState({ worktreeMetadata: new Map([['session-metadata', { path: '/repo/worktrees/metadata' }]]) });

    expect(useSessionUIStore.getState().getAuthoritativeDirectoryForSession('session-metadata')).toBe('/repo/worktrees/metadata');
  });

  test('getAuthoritativeDirectoryForSession resolves attached session directories', () => {
    useSessionWorktreeStore.getState().setAttachment('session-attached', {
      worktreeRoot: '/repo/worktrees/attached',
      cwd: '/repo/worktrees/attached/src',
      branch: 'attached',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'existing',
      legacy: false,
      degraded: false,
    });

    expect(useSessionUIStore.getState().getAuthoritativeDirectoryForSession('session-attached')).toBe('/repo/worktrees/attached/src');
  });

  test('getAuthoritativeDirectoryForSession resolves sync and global session metadata', () => {
    setSyncRefs(opencodeClient, {
      children: new Map([['/repo/sync', { getState: () => ({ session: [{ id: 'session-sync', directory: '/repo/sync' }] }) }]]),
      getState: () => undefined,
    }, '');
    useGlobalSessionsStore.setState({
      activeSessions: [{ id: 'session-global-active', directory: '/repo/global-active' }],
      archivedSessions: [{ id: 'session-global-archived', project: { worktree: '/repo/global-archived' } }],
    });

    expect(useSessionUIStore.getState().getAuthoritativeDirectoryForSession('session-sync')).toBe('/repo/sync');
    expect(useSessionUIStore.getState().getAuthoritativeDirectoryForSession('session-global-active')).toBe('/repo/global-active');
    expect(useSessionUIStore.getState().getAuthoritativeDirectoryForSession('session-global-archived')).toBe('/repo/global-archived');
  });

  test('getDirectoryForSession prefers authoritative attachment cwd over sync fallback', () => {
    useSessionWorktreeStore.getState().setAttachment('session-dir', {
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/repo/worktrees/feat-a/src',
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'existing',
      legacy: false,
      degraded: false,
    });

    expect(useSessionUIStore.getState().getDirectoryForSession('session-dir')).toBe('/repo/worktrees/feat-a/src');
  });

  test('getDirectoryForSession falls back to authoritative worktreeRoot when attachment is degraded', () => {
    useSessionWorktreeStore.getState().setAttachment('session-dir', {
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/tmp/outside',
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'invalid',
      worktreeSource: 'existing',
      legacy: false,
      degraded: true,
    });

    expect(useSessionUIStore.getState().getDirectoryForSession('session-dir')).toBe('/repo/worktrees/feat-a');
  });

  test('setCurrentSession uses canonical cwd when valid', () => {
    const store = useSessionWorktreeStore.getState();

    // Simulate: session has valid worktree metadata with cwd inside worktreeRoot
    store.setAttachment('session-1', {
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/repo/worktrees/feat-a/src',
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'existing',
      legacy: false,
      degraded: false,
    });

    const attachment = store.getAttachment('session-1');
    expect(attachment).toBeDefined();
    expect(attachment.cwd).toBe('/repo/worktrees/feat-a/src');
    expect(attachment.worktreeRoot).toBe('/repo/worktrees/feat-a');
    expect(attachment.degraded).toBe(false);
    expect(attachment.worktreeStatus).toBe('ready');
  });

  test('setCurrentSession falls back to worktreeRoot when cwd is degraded', () => {
    const store = useSessionWorktreeStore.getState();

    // Simulate: cwd is outside worktreeRoot (degraded)
    store.setAttachment('session-2', {
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/repo/worktrees/feat-a', // same as worktreeRoot means not degraded for this case
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'existing',
      legacy: false,
      degraded: true, // marked degraded because cwd was resolved from invalid state
    });

    const attachment = store.getAttachment('session-2');
    expect(attachment).toBeDefined();
    expect(attachment.degraded).toBe(true);
    // cwd should equal worktreeRoot when degraded (fallback)
    expect(attachment.cwd).toBe(attachment.worktreeRoot);
  });

  test('isolated session initializes created-for-session attachment', () => {
    const store = useSessionWorktreeStore.getState();

    // Simulate: isolated worktree session created for a specific branch
    store.setAttachment('session-isolated', {
      worktreeRoot: '/repo/worktrees/feature-xyz',
      cwd: '/repo/worktrees/feature-xyz',
      branch: 'feature-xyz',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'created-for-session',
      legacy: false,
      degraded: false,
    });

    const attachment = store.getAttachment('session-isolated');
    expect(attachment).toBeDefined();
    expect(attachment.worktreeSource).toBe('created-for-session');
    expect(attachment.worktreeStatus).toBe('ready');
    expect(attachment.legacy).toBe(false);
  });

  test('legacy session upgrades when runtime canonicalization recovers a worktree', () => {
    const store = useSessionWorktreeStore.getState();

    // Simulate: session without metadata (legacy) gets upgraded via runtime resolution
    // Initially no attachment
    let attachment = store.getAttachment('session-legacy');
    expect(attachment).toBeUndefined();

    // Runtime canonicalization resolves it to a worktree
    store.setAttachment('session-legacy', {
      worktreeRoot: '/repo/worktrees/recovered',
      cwd: '/repo/worktrees/recovered',
      branch: 'recovered',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'existing',
      legacy: false, // upgraded from legacy=true to false
      degraded: false,
    });

    attachment = store.getAttachment('session-legacy');
    expect(attachment).toBeDefined();
    expect(attachment.legacy).toBe(false);
    expect(attachment.worktreeRoot).toBe('/repo/worktrees/recovered');
  });

  test('missing worktree session has missing status', () => {
    const store = useSessionWorktreeStore.getState();

    // Simulate: session whose worktree was deleted
    store.setAttachment('session-missing', {
      worktreeRoot: null,
      cwd: null,
      branch: null,
      headState: 'branch',
      worktreeStatus: 'missing',
      worktreeSource: null,
      legacy: false,
      degraded: true,
    });

    const attachment = store.getAttachment('session-missing');
    expect(attachment).toBeDefined();
    expect(attachment.worktreeStatus).toBe('missing');
    expect(attachment.degraded).toBe(true);
  });

  test('not-a-repo session has correct status', () => {
    const store = useSessionWorktreeStore.getState();

    // Simulate: session opened in a directory that is not a git repo
    store.setAttachment('session-not-repo', {
      worktreeRoot: null,
      cwd: '/tmp/not-a-repo',
      branch: null,
      headState: 'detached',
      worktreeStatus: 'not-a-repo',
      worktreeSource: null,
      legacy: false,
      degraded: true,
    });

    const attachment = store.getAttachment('session-not-repo');
    expect(attachment).toBeDefined();
    expect(attachment.worktreeStatus).toBe('not-a-repo');
  });
});

describe('queue abort blocks', () => {
  test('keeps a newer exact-scope block when an older abort failure clears its token', () => {
    const store = useSessionUIStore.getState();
    const firstScope = { state: 'bound', transportIdentity: 'runtime-a', directory: '/project-a', sessionID: 'shared-session' };
    const otherScope = { ...firstScope, directory: '/project-b' };
    const firstToken = store.beginQueueAbortBlock(firstScope, 2000);
    const secondToken = store.beginQueueAbortBlock(firstScope, 2000);
    store.beginQueueAbortBlock(otherScope, 2000);
    store.clearQueueAbortBlock(firstScope, firstToken);

    expect(useSessionUIStore.getState().queueAbortBlocks.get(queueScopeKey(firstScope))?.token).toBe(secondToken);
    expect(useSessionUIStore.getState().queueAbortBlocks.has(queueScopeKey(otherScope))).toBe(true);
    useSessionUIStore.getState().pruneQueueAbortBlocks(Date.now() + 2001);
    expect(useSessionUIStore.getState().queueAbortBlocks.size).toBe(0);
  });
});

describe('routeMessage directory scoping', () => {
  test('runs sends in the provided session directory', async () => {
    // The session directory travels as an explicit request param (not via
    // client-wide directory scoping), so concurrent sends can't cross-talk.
    const calls = [];
    const originalShellSession = opencodeClient.shellSession;

    opencodeClient.shellSession = async (params) => {
      calls.push(params);
      return { info: {}, parts: [] };
    };

    try {
      await routeMessage({
        sessionId: 'session-a',
        directory: '/session/project',
        content: 'pwd',
        providerID: 'provider-a',
        modelID: 'model-a',
        inputMode: 'shell',
      });
    } finally {
      opencodeClient.shellSession = originalShellSession;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBe('session-a');
    expect(calls[0].directory).toBe('/session/project');
  });
});

describe('openNewSessionDraft project binding', () => {
  const projectA = { id: 'proj-a', path: '/projects/alpha', label: 'Alpha' };
  const projectB = { id: 'proj-b', path: '/projects/beta', label: 'Beta' };

  beforeEach(() => {
    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: { open: false, directoryOverride: null, parentID: null },
      availableWorktreesByProject: new Map(),
    });
    useProjectsStore.setState({
      projects: [projectA, projectB],
      activeProjectId: projectA.id,
    });
    useDirectoryStore.getState().setDirectory(projectB.path, { showOverlay: false });
  });

  test('keeps implicit draft on current directory when active project differs', () => {
    useSessionUIStore.getState().openNewSessionDraft();
    const draft = useSessionUIStore.getState().newSessionDraft;

    expect(draft.open).toBe(true);
    expect(draft.selectedProjectId).toBe(projectB.id);
    expect(draft.directoryOverride).toBe(projectB.path);
    expect(useProjectsStore.getState().activeProjectId).toBe(projectB.id);
  });

  test('defaults Welcome draft to the current conversation project', () => {
    useDirectoryStore.getState().setDirectory(projectB.path, { showOverlay: false });
    useSessionUIStore.setState({
      currentSessionId: 'session-alpha',
      currentSessionDirectory: projectA.path,
    });

    useSessionUIStore.getState().openNewSessionDraft();
    const draft = useSessionUIStore.getState().newSessionDraft;

    expect(draft.open).toBe(true);
    expect(draft.selectedProjectId).toBe(projectA.id);
    expect(draft.directoryOverride).toBe(projectA.path);
    expect(useProjectsStore.getState().activeProjectId).toBe(projectA.id);
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  });

  test('does not attach active project when current directory is unmatched', () => {
    useDirectoryStore.getState().setDirectory('/external/worktree', { showOverlay: false });

    useSessionUIStore.getState().openNewSessionDraft();
    const draft = useSessionUIStore.getState().newSessionDraft;

    expect(draft.open).toBe(true);
    expect(draft.selectedProjectId).toBeNull();
    expect(draft.directoryOverride).toBe('/external/worktree');
  });

  test('respects explicit directoryOverride over active project', () => {
    useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: '/projects/beta/src' });
    const draft = useSessionUIStore.getState().newSessionDraft;

    expect(draft.open).toBe(true);
    expect(draft.directoryOverride).toBe('/projects/beta/src');
  });

  test('respects explicit selectedProjectId over active project', () => {
    useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: projectB.id });
    const draft = useSessionUIStore.getState().newSessionDraft;

    expect(draft.open).toBe(true);
    expect(draft.selectedProjectId).toBe(projectB.id);
  });

  test('registers an unmatched deep-link directory as a project before opening its draft', () => {
    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: '/projects/from-deep-link',
      ensureProjectForDirectory: true,
    });

    const draft = useSessionUIStore.getState().newSessionDraft;
    const createdProject = useProjectsStore.getState().projects.find((project) => project.path === '/projects/from-deep-link');

    expect(createdProject).toBeDefined();
    expect(draft.open).toBe(true);
    expect(draft.selectedProjectId).toBe(createdProject?.id);
    expect(draft.directoryOverride).toBe('/projects/from-deep-link');
    expect(useProjectsStore.getState().activeProjectId).toBe(createdProject?.id);
  });

  test('new draft activation explicitly requests a Provider refresh', async () => {
    const originalActivateDirectory = useConfigStore.getState().activateDirectory;
    const calls = [];
    useConfigStore.setState({ activateDirectory: async (...args) => { calls.push(args); } });
    try {
      useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: projectA.id });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toEqual([[projectA.path, { refreshProviders: true, source: 'newSessionDraft' }]]);
    } finally {
      useConfigStore.setState({ activateDirectory: originalActivateDirectory });
    }
  });

  test('applies defaults only for the latest completed draft activation', async () => {
    const originalActivateDirectory = useConfigStore.getState().activateDirectory;
    const originalApplyDefaultModelAgentSelection = useConfigStore.getState().applyDefaultModelAgentSelection;
    const activations = new Map();
    const appliedDirectories = [];
    useConfigStore.setState({
      activateDirectory: (directory) => {
        useConfigStore.setState({ activeDirectoryKey: directory ?? '' });
        const activation = { resolve: undefined, promise: undefined };
        activation.promise = new Promise((resolve) => { activation.resolve = resolve; });
        activations.set(directory, activation);
        return activation.promise;
      },
      applyDefaultModelAgentSelection: () => {
        appliedDirectories.push(useConfigStore.getState().activeDirectoryKey);
      },
    });

    try {
      useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: projectA.id });
      useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: projectB.id });
      activations.get(projectA.path).resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(appliedDirectories).toEqual([]);

      activations.get(projectB.path).resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(appliedDirectories).toEqual([projectB.path]);
    } finally {
      useConfigStore.setState({
        activateDirectory: originalActivateDirectory,
        applyDefaultModelAgentSelection: originalApplyDefaultModelAgentSelection,
      });
    }
  });

  test('does not create a duplicate project when a deep-link directory is already covered', () => {
    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: '/projects/beta/src',
      ensureProjectForDirectory: true,
    });

    const draft = useSessionUIStore.getState().newSessionDraft;

    expect(useProjectsStore.getState().projects).toHaveLength(2);
    expect(draft.selectedProjectId).toBe(projectB.id);
    expect(draft.directoryOverride).toBe('/projects/beta/src');
  });
});

describe('new-session draft identity', () => {
  beforeEach(() => {
    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: { open: false, draftID: null, directoryOverride: null, parentID: null, draftSubmitting: false, submissionToken: 0 },
      availableWorktreesByProject: new Map(),
    });
    useProjectsStore.setState({ projects: [], activeProjectId: null });
    useDirectoryStore.setState({ currentDirectory: null });
  });

  test('creates a UUID on first open, retains it while idle, rotates it while submitting, and clears it on close', () => {
    const store = useSessionUIStore.getState();
    store.openNewSessionDraft();
    const first = useSessionUIStore.getState().newSessionDraft;
    expect(first.draftID).toMatch(/^[0-9a-f-]{36}$/i);

    store.openNewSessionDraft();
    const idle = useSessionUIStore.getState().newSessionDraft;
    expect(idle.draftID).toBe(first.draftID);
    expect(idle.submissionToken).toBe(first.submissionToken);

    useSessionUIStore.setState({ newSessionDraft: { ...idle, draftSubmitting: true, submissionToken: 4 } });
    store.openNewSessionDraft();
    const replaced = useSessionUIStore.getState().newSessionDraft;
    expect(replaced.draftID).not.toBe(first.draftID);
    expect(replaced.submissionToken).toBe(0);

    store.closeNewSessionDraft();
    expect(useSessionUIStore.getState().newSessionDraft.draftID).toBeNull();
  });
});

describe('routeMessage skill invocation', () => {
  // Skills remain regular prompts so the model loads them through the skill tool.
  // Configured commands continue to use session.command.
  const sendCommandCalls = [];
  const sendMessageCalls = [];
  let originalSendCommand;
  let originalSendMessage;
  let originalFetchQuery;
  let queryResults;
  let queryFetches;
  let optimisticAdds;

  beforeEach(() => {
    sendCommandCalls.length = 0;
    sendMessageCalls.length = 0;

    // Minimal optimistic + connection machinery so routeMessage can dispatch.
    const childStore = {
      getState: () => ({ session_status: {} }),
      setState: () => {},
    };
    const childStores = {
      children: new Map(),
      ensureChild: () => childStore,
      getChild: () => childStore,
    };
    setActionRefs(opencodeClient, childStores, () => '/skills/project');
    optimisticAdds = [];
    setOptimisticRefs((payload) => optimisticAdds.push(payload), () => {});
    useConfigStore.setState({ isConnected: true });

    queryClient.removeQueries({ queryKey: installedSkillsQueryOptions('/skills/project').queryKey });
    queryClient.removeQueries({ queryKey: commandQueryOptions('/skills/project').queryKey });

    queryResults = { commands: [], skills: [] };
    queryFetches = [];
    originalFetchQuery = queryClient.fetchQuery;
    queryClient.fetchQuery = async (options) => {
      queryFetches.push(options.queryKey);
      if (JSON.stringify(options.queryKey) === JSON.stringify(commandQueryOptions('/skills/project').queryKey)) {
        if (queryResults.commands instanceof Error) throw queryResults.commands;
        return queryResults.commands;
      }
      if (JSON.stringify(options.queryKey) === JSON.stringify(installedSkillsQueryOptions('/skills/project').queryKey)) {
        if (queryResults.skills instanceof Error) throw queryResults.skills;
        return queryResults.skills;
      }
      throw new Error('Unexpected slash query');
    };

    originalSendCommand = opencodeClient.sendCommand;
    originalSendMessage = opencodeClient.sendMessage;
    opencodeClient.sendCommand = async (params) => {
      sendCommandCalls.push(params);
      return 'msg';
    };
    opencodeClient.sendMessage = async (params) => {
      sendMessageCalls.push(params);
      return 'msg';
    };
  });

  afterEach(() => {
    opencodeClient.sendCommand = originalSendCommand;
    opencodeClient.sendMessage = originalSendMessage;
    queryClient.fetchQuery = originalFetchQuery;
    queryClient.removeQueries({ queryKey: installedSkillsQueryOptions('/skills/project').queryKey });
    queryClient.removeQueries({ queryKey: commandQueryOptions('/skills/project').queryKey });
  });

  test('sends a user-installed skill as a regular prompt', async () => {
    queryClient.setQueryData(installedSkillsQueryOptions('/skills/project').queryKey, [{ name: 'grill-with-docs', path: '/skills/grill-with-docs/SKILL.md', scope: 'user', source: 'opencode' }]);

    await routeMessage({
      sessionId: 'session-skill',
      directory: '/skills/project',
      content: '/grill-with-docs',
      providerID: 'provider-a',
      modelID: 'model-a',
      additionalParts: [{ text: 'Use the corresponding skill tool.', synthetic: true }],
    });

    expect(sendCommandCalls).toHaveLength(0);
    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0].text).toBe('/grill-with-docs');
    expect(sendMessageCalls[0].additionalParts).toEqual([{ text: 'Use the corresponding skill tool.', synthetic: true }]);
  });

  test('loads a cold skill cache before classifying a slash token', async () => {
    queryResults.skills = [{ name: 'cold-skill', path: '/skills/cold-skill/SKILL.md', scope: 'user', source: 'opencode' }];

    await routeMessage({
      sessionId: 'session-skill',
      directory: '/skills/project',
      content: '/cold-skill',
      providerID: 'provider-a',
      modelID: 'model-a',
    });

    expect(queryFetches).toHaveLength(2);
    expect(sendCommandCalls).toHaveLength(0);
    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0].text).toBe('/cold-skill');
  });

  test('loads a cold command cache before classifying a slash token', async () => {
    queryResults.commands = [{ name: 'cold-command', isBuiltIn: true }];

    await routeMessage({
      sessionId: 'session-command',
      directory: '/skills/project',
      content: '/cold-command argument',
      providerID: 'provider-a',
      modelID: 'model-a',
    });

    expect(queryFetches).toHaveLength(2);
    expect(sendCommandCalls).toHaveLength(1);
    expect(sendCommandCalls[0]).toMatchObject({ command: 'cold-command', arguments: 'argument' });
    expect(sendMessageCalls).toHaveLength(0);
  });

  test('sends a markdown custom command as a structured normal prompt', async () => {
    queryClient.setQueryData(commandQueryOptions('/skills/project').queryKey, [{
      name: 'markdown-command',
      isBuiltIn: false,
      reference: '/skills/project/.opencode/commands/markdown-command.md',
    }]);

    await routeMessage({
      sessionId: 'session-command',
      directory: '/skills/project',
      content: '/markdown-command focus on auth',
      providerID: 'provider-a',
      modelID: 'model-a',
      files: [{ type: 'file', mime: 'text/plain', url: 'file:///notes.txt', filename: 'notes.txt' }],
      additionalParts: [{ text: 'Synthetic context', synthetic: true }],
      messageID: 'msg-custom-command',
    });

    const content = '[command:/skills/project/.opencode/commands/markdown-command.md] focus on auth';
    expect(sendCommandCalls).toHaveLength(0);
    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0]).toMatchObject({
      text: content,
      messageId: 'msg-custom-command',
      files: [{ type: 'file', mime: 'text/plain', url: 'file:///notes.txt', filename: 'notes.txt' }],
      additionalParts: [{ text: 'Synthetic context', synthetic: true }],
    });
    expect(optimisticAdds).toHaveLength(1);
    expect(optimisticAdds[0].parts[0].text).toBe(content);
  });

  test('uses a JSON custom command name as the structured reference', async () => {
    queryClient.setQueryData(commandQueryOptions('/skills/project').queryKey, [{ name: 'json-command', isBuiltIn: false }]);

    await routeMessage({
      sessionId: 'session-command',
      directory: '/skills/project',
      content: '/json-command',
      providerID: 'provider-a',
      modelID: 'model-a',
    });

    expect(sendCommandCalls).toHaveLength(0);
    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0].text).toBe('[command:json-command]');
  });

  test('sends built-in commands through session.command', async () => {
    queryClient.setQueryData(commandQueryOptions('/skills/project').queryKey, [{ name: 'built-in-command', isBuiltIn: true }]);

    await routeMessage({
      sessionId: 'session-command',
      directory: '/skills/project',
      content: '/built-in-command argument',
      providerID: 'provider-a',
      modelID: 'model-a',
    });

    expect(sendCommandCalls).toHaveLength(1);
    expect(sendCommandCalls[0]).toMatchObject({ command: 'built-in-command', arguments: 'argument' });
    expect(sendMessageCalls).toHaveLength(0);
  });

  test('uses the first whitespace boundary and preserves trimmed slash arguments', async () => {
    queryClient.setQueryData(commandQueryOptions('/skills/project').queryKey, [
      { name: 'built-in-command', isBuiltIn: true },
      { name: 'custom-command', isBuiltIn: false, reference: '/commands/custom-command.md' },
    ]);

    await routeMessage({
      sessionId: 'session-command',
      directory: '/skills/project',
      content: '/built-in-command\t first\r\n second  ',
      providerID: 'provider-a',
      modelID: 'model-a',
    });
    await routeMessage({
      sessionId: 'session-command',
      directory: '/skills/project',
      content: '/custom-command\r\n  focus on auth  ',
      providerID: 'provider-a',
      modelID: 'model-a',
    });

    expect(sendCommandCalls[0]).toMatchObject({ command: 'built-in-command', arguments: 'first\r\n second' });
    expect(sendMessageCalls[0].text).toBe('[command:/commands/custom-command.md] focus on auth');
  });

  test('preserves trailing skill instructions in the regular prompt', async () => {
    queryClient.setQueryData(installedSkillsQueryOptions('/skills/project').queryKey, [{ name: 'grill-with-docs', path: '/skills/grill-with-docs/SKILL.md', scope: 'user', source: 'opencode' }]);

    await routeMessage({
      sessionId: 'session-skill',
      directory: '/skills/project',
      content: '/grill-with-docs focus on auth',
      providerID: 'provider-a',
      modelID: 'model-a',
    });

    expect(sendCommandCalls).toHaveLength(0);
    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0].text).toBe('/grill-with-docs focus on auth');
  });

  test('prefers an installed skill when a command shares its name', async () => {
    queryClient.setQueryData(commandQueryOptions('/skills/project').queryKey, [{ name: 'shared-name' }]);
    queryClient.setQueryData(installedSkillsQueryOptions('/skills/project').queryKey, [{ name: 'shared-name', path: '/skills/shared-name/SKILL.md', scope: 'user', source: 'opencode' }]);

    await routeMessage({
      sessionId: 'session-skill',
      directory: '/skills/project',
      content: '/shared-name use this workflow',
      providerID: 'provider-a',
      modelID: 'model-a',
    });

    expect(sendCommandCalls).toHaveLength(0);
    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0].text).toBe('/shared-name use this workflow');
  });

  test('sends an unknown slash token as a plain message', async () => {
    queryClient.setQueryData(commandQueryOptions('/skills/project').queryKey, []);
    queryClient.setQueryData(installedSkillsQueryOptions('/skills/project').queryKey, []);

    await routeMessage({
      sessionId: 'session-skill',
      directory: '/skills/project',
      content: '/not-a-real-skill',
      providerID: 'provider-a',
      modelID: 'model-a',
    });

    expect(sendMessageCalls).toHaveLength(1);
    expect(sendCommandCalls).toHaveLength(0);
    expect(queryFetches).toHaveLength(0);
  });

  test('rejects a slash send when command discovery fails', async () => {
    queryResults.commands = new Error('command discovery failed');

    await expect(routeMessage({
      sessionId: 'session-command',
      directory: '/skills/project',
      content: '/cold-command',
      providerID: 'provider-a',
      modelID: 'model-a',
    })).rejects.toThrow('command discovery failed');

    expect(sendCommandCalls).toHaveLength(0);
    expect(sendMessageCalls).toHaveLength(0);
  });

  test('retries command discovery after a failed slash send', async () => {
    queryResults.commands = new Error('command discovery failed');

    await expect(routeMessage({
      sessionId: 'session-command',
      directory: '/skills/project',
      content: '/retry-command',
      providerID: 'provider-a',
      modelID: 'model-a',
    })).rejects.toThrow('command discovery failed');

    queryResults.commands = [{ name: 'retry-command', isBuiltIn: true }];

    await routeMessage({
      sessionId: 'session-command',
      directory: '/skills/project',
      content: '/retry-command',
      providerID: 'provider-a',
      modelID: 'model-a',
    });

    expect(queryFetches).toHaveLength(4);
    expect(sendCommandCalls).toHaveLength(1);
    expect(sendCommandCalls[0].command).toBe('retry-command');
    expect(sendMessageCalls).toHaveLength(0);
  });
});

describe('draftEstablishing paint prelude', () => {
  beforeEach(() => {
    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: { open: false, draftID: null, directoryOverride: null, parentID: null, draftSubmitting: false, draftEstablishing: false, submissionToken: 0 },
    });
  });

  test('beginDraftEstablishingPaint sets flag before claim', async () => {
    useSessionUIStore.getState().openNewSessionDraft();
    expect(await beginDraftEstablishingPaint()).toBe(true);
    expect(useSessionUIStore.getState().newSessionDraft.draftEstablishing).toBe(true);
    expect(useSessionUIStore.getState().newSessionDraft.draftSubmitting).toBe(false);
  });

  test('clearDraftEstablishingPaint drops the prelude', async () => {
    useSessionUIStore.getState().openNewSessionDraft();
    await beginDraftEstablishingPaint();
    clearDraftEstablishingPaint();
    expect(useSessionUIStore.getState().newSessionDraft.draftEstablishing).toBe(false);
  });

  test('second begin is rejected while establishing', async () => {
    useSessionUIStore.getState().openNewSessionDraft();
    expect(await beginDraftEstablishingPaint()).toBe(true);
    expect(await beginDraftEstablishingPaint()).toBe(false);
    expect(useSessionUIStore.getState().newSessionDraft.draftEstablishing).toBe(true);
  });

  test('materialize claim clears draftEstablishing and sets draftSubmitting', async () => {
    const projectA = { id: 'proj-a', path: '/projects/alpha', label: 'Alpha' };
    const childStore = {
      getState: () => ({ session_status: {}, message: {}, session: [], part: {} }),
      setState: () => {},
    };
    setActionRefs(opencodeClient, {
      children: new Map(),
      ensureChild: () => childStore,
      getChild: () => childStore,
    }, () => projectA.path);
    setOptimisticRefs(() => {}, () => {});

    let resolveCreate;
    const originalCreateSession = opencodeClient.createSession;
    opencodeClient.createSession = () => new Promise((resolve) => { resolveCreate = resolve; });

    try {
      useProjectsStore.setState({ projects: [projectA], activeProjectId: projectA.id });
      useDirectoryStore.setState({ currentDirectory: projectA.path });
      useSessionUIStore.getState().openNewSessionDraft();
      await beginDraftEstablishingPaint();
      expect(useSessionUIStore.getState().newSessionDraft.draftEstablishing).toBe(true);

      const materializePromise = materializeOpenDraftSession({ providerID: 'p', modelID: 'm' });
      // claimDraftSubmission promotes establishing → submitting before its paint await.
      expect(useSessionUIStore.getState().newSessionDraft.draftEstablishing).toBe(false);
      expect(useSessionUIStore.getState().newSessionDraft.draftSubmitting).toBe(true);

      // claim's paint gate yields before createSession is invoked.
      await new Promise((resolve) => setTimeout(resolve, 0));
      resolveCreate({ id: 'ses-establishing-001', directory: projectA.path });
      await materializePromise;
    } finally {
      opencodeClient.createSession = originalCreateSession;
    }
  });
});

describe('materializeOpenDraftSession atomic lifecycle', () => {
  const projectA = { id: 'proj-a', path: '/projects/alpha', label: 'Alpha' };

  let originalCreateSession;
  let createSessionDeferred;
  let createSessionCalls;

  beforeEach(() => {
    // Set up child stores so createSessionAction dir() works
    const childStore = {
      getState: () => ({ session_status: {}, message: {}, session: [], part: {} }),
      setState: () => {},
    };
    const childStores = {
      children: new Map(),
      ensureChild: () => childStore,
      getChild: () => childStore,
    };
    setActionRefs(opencodeClient, childStores, () => projectA.path);
    setOptimisticRefs(() => {}, () => {});

    createSessionCalls = [];
    createSessionDeferred = null;
    originalCreateSession = opencodeClient.createSession;
    opencodeClient.createSession = (...args) => {
      createSessionCalls.push(args);
      if (!createSessionDeferred) {
        // Default: immediate success
        return Promise.resolve({
          id: 'ses-mocked-001',
          directory: createSessionCalls[createSessionCalls.length - 1]?.[1] ?? null,
        });
      }
      return createSessionDeferred.promise;
    };

    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: { open: false, directoryOverride: null, parentID: null, draftSubmitting: false, submissionToken: 0 },
      availableWorktreesByProject: new Map(),
    });
    useProjectsStore.setState({
      projects: [projectA],
      activeProjectId: projectA.id,
    });
    useDirectoryStore.setState({ currentDirectory: projectA.path });
  });

  afterEach(() => {
    opencodeClient.createSession = originalCreateSession;
  });

  test('sets draftSubmitting synchronously before createSession resolves', () => {
    // Use a deferred promise so materializeOpenDraftSession hangs on the await
    let resolveCreate;
    createSessionDeferred = {
      promise: new Promise((resolve) => { resolveCreate = resolve; }),
    };

    useSessionUIStore.getState().openNewSessionDraft();

    // Start materialization — this will set draftSubmitting then await
    const materializePromise = materializeOpenDraftSession({
      providerID: 'p',
      modelID: 'm',
    });

    // draftSubmitting must be true synchronously (before promise resolves)
    const draft = useSessionUIStore.getState().newSessionDraft;
    expect(draft.open).toBe(true);
    expect(draft.draftSubmitting).toBe(true);

    // Now resolve the pending createSession
    resolveCreate({
      id: 'ses-mocked-001',
    });

    return materializePromise.then((result) => {
      expect(result).not.toBeNull();
      expect(result.sessionId).toBe('ses-mocked-001');
      // After success, draft should be closed (setCurrentSession → closeNewSessionDraft)
      expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false);
      expect(useSessionUIStore.getState().newSessionDraft.draftSubmitting).toBe(false);
    });
  });

  test('concurrent calls: second one returns null after first claims draft', () => {
    let resolveCreate;
    createSessionDeferred = {
      promise: new Promise((resolve) => { resolveCreate = resolve; }),
    };

    useSessionUIStore.getState().openNewSessionDraft();

    const first = materializeOpenDraftSession({ providerID: 'p', modelID: 'm' });
    const second = materializeOpenDraftSession({ providerID: 'p', modelID: 'm' });

    // Second call should return null immediately (draft already claimed)
    expect(second).resolves.toBeNull();

    resolveCreate({
      id: 'ses-mocked-001',
    });

    return first.then((result) => {
      expect(result).not.toBeNull();
      expect(createSessionCalls.length).toBe(1); // Only one createSession call
    });
  });

  test('failure clears draftSubmitting and leaves draft retryable (same token)', async () => {
    let rejectCreate;
    createSessionDeferred = {
      promise: new Promise((_, reject) => { rejectCreate = reject; }),
    };

    useSessionUIStore.getState().openNewSessionDraft();

    const materializePromise = materializeOpenDraftSession({
      providerID: 'p',
      modelID: 'm',
    });

    // draftSubmitting must be set synchronously (before paint-gate yield)
    expect(useSessionUIStore.getState().newSessionDraft.draftSubmitting).toBe(true);

    // Claim yields one frame before createSession; wait until the deferred is held.
    for (let i = 0; i < 20 && createSessionCalls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(createSessionCalls.length).toBe(1);

    // Fail the create
    rejectCreate(new Error('network error'));

    const result = await materializePromise;
    expect(result).toBeNull();
    const draft = useSessionUIStore.getState().newSessionDraft;
    expect(draft.open).toBe(true);
    expect(draft.draftSubmitting).toBe(false);
  });

  test('failure does not reopen closed draft (user navigated away)', async () => {
    let rejectCreate;
    createSessionDeferred = {
      promise: new Promise((_, reject) => { rejectCreate = reject; }),
    };

    useSessionUIStore.getState().openNewSessionDraft();

    const materializePromise = materializeOpenDraftSession({
      providerID: 'p',
      modelID: 'm',
    });

    // Claim yields one frame before createSession; wait until the deferred is held.
    for (let i = 0; i < 20 && createSessionCalls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(createSessionCalls.length).toBe(1);

    // While createSession is pending, user opens a new draft (closing the old)
    useSessionUIStore.getState().closeNewSessionDraft();
    useSessionUIStore.getState().openNewSessionDraft();

    // Now fail the original createSession
    rejectCreate(new Error('create failed'));

    const result = await materializePromise;
    expect(result).toBeNull();

    const draft = useSessionUIStore.getState().newSessionDraft;
    // The new draft should still be open and NOT have submitting set
    expect(draft.open).toBe(true);
    expect(draft.draftSubmitting).toBe(false);
  });

  test('materializeOpenDraftSession returns null when draft is not open', async () => {
    const result = await materializeOpenDraftSession({
      providerID: 'p',
      modelID: 'm',
    });
    expect(result).toBeNull();
  });
});

describe('new-session draft ownership lifecycle', () => {
  let originalCaptureDraftRuntime;
  let originalGetDraft;
  let originalFinalizeDraftOwnership;
  let originalCreateSession;

  beforeEach(() => {
    const input = useInputStore.getState();
    originalCaptureDraftRuntime = input.captureDraftRuntime;
    originalGetDraft = input.getDraft;
    originalFinalizeDraftOwnership = input.finalizeDraftOwnership;
    originalCreateSession = opencodeClient.createSession;
    opencodeClient.createSession = async (_title, directory) => ({ id: 'ses-owner', directory });
    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: { open: false, draftID: null, directoryOverride: null, parentID: null, draftSubmitting: false, submissionToken: 0 },
      availableWorktreesByProject: new Map(),
    });
    useProjectsStore.setState({ projects: [], activeProjectId: null });
    useDirectoryStore.setState({ currentDirectory: null });
  });

  afterEach(() => {
    useInputStore.setState({
      captureDraftRuntime: originalCaptureDraftRuntime,
      getDraft: originalGetDraft,
      finalizeDraftOwnership: originalFinalizeDraftOwnership,
    });
    opencodeClient.createSession = originalCreateSession;
  });

  test('restores each runtime draft identity after A/B prepare and restore', () => {
    const draftA = crypto.randomUUID();
    const draftB = crypto.randomUUID();
    useSessionUIStore.setState({ newSessionDraft: { open: true, draftID: draftA, directoryOverride: null, parentID: null, draftSubmitting: false, submissionToken: 1 } });
    useSessionUIStore.getState().prepareForRuntimeSwitch('runtime-a');
    useSessionUIStore.setState({ newSessionDraft: { open: true, draftID: draftB, directoryOverride: null, parentID: null, draftSubmitting: false, submissionToken: 2 } });
    useSessionUIStore.getState().prepareForRuntimeSwitch('runtime-b');

    useSessionUIStore.getState().restoreForRuntimeSwitch('runtime-a');
    expect(useSessionUIStore.getState().newSessionDraft.draftID).toBe(draftA);
    useSessionUIStore.getState().restoreForRuntimeSwitch('runtime-b');
    expect(useSessionUIStore.getState().newSessionDraft.draftID).toBe(draftB);
  });

  test('materialization preserves the opened source record with its exact key, revision, and runtime', async () => {
    const runtime = { transportIdentity: 'runtime-owner', generation: 4 };
    const calls = [];
    useInputStore.setState({
      captureDraftRuntime: () => runtime,
      getDraft: (key) => ({ key, revision: 17 }),
      finalizeDraftOwnership: async (input) => { calls.push(input); return { status: 'committed', current: true, durable: true }; },
    });
    useSessionUIStore.getState().openNewSessionDraft();
    const draftID = useSessionUIStore.getState().newSessionDraft.draftID;
    const result = await materializeOpenDraftSession({ providerID: 'p', modelID: 'm' });

    expect(result?.sessionId).toBe('ses-owner');
    expect(calls).toEqual([{
      source: newSessionDraftKey(runtime, draftID),
      destination: sessionDraftKey(runtime, 'ses-owner'),
      expectedSourceRevision: 17,
      disposition: 'preserve',
      runtime,
    }]);
  });

  test('materialization skips ownership when its opened source record is missing', async () => {
    let calls = 0;
    useInputStore.setState({
      captureDraftRuntime: () => ({ transportIdentity: 'runtime-owner', generation: 4 }),
      getDraft: () => undefined,
      finalizeDraftOwnership: async () => { calls++; return { status: 'committed', current: true, durable: true }; },
    });
    useSessionUIStore.getState().openNewSessionDraft();
    await materializeOpenDraftSession({ providerID: 'p', modelID: 'm' });
    expect(calls).toBe(0);
  });

  test('ownership rejection keeps the created session result', async () => {
    const runtime = { transportIdentity: 'runtime-owner', generation: 4 };
    useInputStore.setState({
      captureDraftRuntime: () => runtime,
      getDraft: (key) => ({ key, revision: 17 }),
      finalizeDraftOwnership: async () => { throw new Error('durability rejected'); },
    });
    useSessionUIStore.getState().openNewSessionDraft();
    const result = await materializeOpenDraftSession({ providerID: 'p', modelID: 'm' });
    expect(result?.sessionId).toBe('ses-owner');
  });

  test('a switched-away failed claim clears its old runtime memory and restores retryability', async () => {
    let runtime = { transportIdentity: 'runtime-a', generation: 1 };
    let rejectCreate;
    let createStarted;
    const createStartedPromise = new Promise((resolve) => { createStarted = resolve; });
    opencodeClient.createSession = () => new Promise((_, reject) => { rejectCreate = reject; createStarted(); });
    useInputStore.setState({
      captureDraftRuntime: () => runtime,
      getDraft: () => undefined,
    });
    useSessionUIStore.getState().openNewSessionDraft();
    const pending = materializeOpenDraftSession({ providerID: 'p', modelID: 'm' });
    expect(useSessionUIStore.getState().newSessionDraft.draftSubmitting).toBe(true);
    await createStartedPromise;
    useSessionUIStore.getState().prepareForRuntimeSwitch();

    runtime = { transportIdentity: 'runtime-b', generation: 2 };
    rejectCreate(new Error('old runtime failed'));
    expect(await pending).toBeNull();

    runtime = { transportIdentity: 'runtime-a', generation: 1 };
    useSessionUIStore.getState().restoreForRuntimeSwitch();
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);
    expect(useSessionUIStore.getState().newSessionDraft.draftSubmitting).toBe(false);
  });
});

describe('createSession preserves pure semantics (no draftSubmitting pollution)', () => {
  const projectA = { id: 'proj-a', path: '/projects/alpha', label: 'Alpha' };

  let originalCreateSession;
  let createSessionCalls;

  beforeEach(() => {
    // Set up child stores so createSessionAction dir() works
    const childStore = {
      getState: () => ({ session_status: {}, message: {}, session: [], part: {} }),
      setState: () => {},
    };
    const childStores = {
      children: new Map(),
      ensureChild: () => childStore,
      getChild: () => childStore,
    };
    setActionRefs(opencodeClient, childStores, () => projectA.path);
    setOptimisticRefs(() => {}, () => {});

    createSessionCalls = [];
    originalCreateSession = opencodeClient.createSession;
    opencodeClient.createSession = (...args) => {
      createSessionCalls.push(args);
      return Promise.resolve({ id: 'ses-pure-001', directory: args[1] ?? null });
    };

    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: { open: false, directoryOverride: null, parentID: null, draftSubmitting: false, submissionToken: 0 },
      availableWorktreesByProject: new Map(),
    });
    useProjectsStore.setState({
      projects: [projectA],
      activeProjectId: projectA.id,
    });
    useDirectoryStore.setState({ currentDirectory: projectA.path });
  });

  afterEach(() => {
    opencodeClient.createSession = originalCreateSession;
  });

  test('createSession closes draft and does not set draftSubmitting', async () => {
    // Open a draft, then directly call createSession
    useSessionUIStore.getState().openNewSessionDraft();
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);

    const session = await useSessionUIStore.getState().createSession('test', null, null);

    expect(session).not.toBeNull();
    const draft = useSessionUIStore.getState().newSessionDraft;
    // Draft should be closed (closeNewSessionDraft was called)
    expect(draft.open).toBe(false);
    // draftSubmitting should never have been touched by createSession
    expect(draft.draftSubmitting).toBe(false);
  });

  test('createSession restores draft on failure when no new draft opened', async () => {
    // Simulate a transient failure by rejecting createSession
    opencodeClient.createSession = () => Promise.reject(new Error('network error'));

    useSessionUIStore.getState().openNewSessionDraft();
    const originalDraft = useSessionUIStore.getState().newSessionDraft;
    expect(originalDraft.open).toBe(true);
    expect(originalDraft.directoryOverride).toBe('/projects/alpha');

    const session = await useSessionUIStore.getState().createSession('test', null, null);

    expect(session).toBeNull();
    const draft = useSessionUIStore.getState().newSessionDraft;
    // Draft should be restored — user can retry
    expect(draft.open).toBe(true);
    expect(draft.directoryOverride).toBe('/projects/alpha');
    expect(draft.draftSubmitting).toBe(false);
  });

  test('createSession does not restore draft when user opened new draft during failure', async () => {
    let rejectCreate;
    opencodeClient.createSession = () => new Promise((_, reject) => { rejectCreate = reject; });

    useSessionUIStore.getState().openNewSessionDraft();

    const createPromise = useSessionUIStore.getState().createSession('test', null, null);

    // User opens a new draft while createSession is pending
    useSessionUIStore.getState().closeNewSessionDraft();
    useSessionUIStore.getState().openNewSessionDraft({ title: 'Newer draft' });

    rejectCreate(new Error('create failed'));
    const session = await createPromise;

    expect(session).toBeNull();
    const draft = useSessionUIStore.getState().newSessionDraft;
    // The user's newer draft should be preserved, not overwritten
    expect(draft.open).toBe(true);
    expect(draft.title).toBe('Newer draft');
    expect(draft.draftSubmitting).toBe(false);
  });

  test('createSession can be called without an open draft', async () => {
    const session = await useSessionUIStore.getState().createSession('no-draft', null, null);
    expect(session).not.toBeNull();
    // Should not throw or pollute draft state
    const draft = useSessionUIStore.getState().newSessionDraft;
    expect(draft.open).toBe(false);
    expect(draft.draftSubmitting).toBe(false);
  });
});

describe('setNewSessionDraftTarget force unlock', () => {
  const projectRoot = '/projects/alpha';
  const worktreePath = '/projects/alpha/.slim/worktrees/feature';

  beforeEach(() => {
    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: {
        open: true,
        draftID: 'draft-force-unlock',
        selectedProjectId: 'proj-a',
        directoryOverride: worktreePath,
        pendingWorktreeRequestId: null,
        bootstrapPendingDirectory: worktreePath,
        preserveDirectoryOverride: true,
        parentID: null,
        draftSubmitting: false,
        draftEstablishing: false,
        submissionToken: 0,
      },
      availableWorktreesByProject: new Map(),
    });
    useProjectsStore.setState({
      projects: [{ id: 'proj-a', path: projectRoot, label: 'Alpha' }],
      activeProjectId: 'proj-a',
    });
    useDirectoryStore.getState().setDirectory(worktreePath, { showOverlay: false });
  });

  test('force:true clears bootstrap/preserve locks so project root can be reselected', () => {
    useSessionUIStore.getState().setNewSessionDraftTarget({
      projectId: 'proj-a',
      directoryOverride: projectRoot,
    }, { force: true });

    const draft = useSessionUIStore.getState().newSessionDraft;
    expect(draft.directoryOverride).toBe(projectRoot);
    expect(draft.bootstrapPendingDirectory).toBeNull();
    expect(draft.preserveDirectoryOverride).toBe(false);
  });

  test('without force keeps create-time locks so automatic resets cannot steal the worktree', () => {
    useSessionUIStore.getState().setNewSessionDraftTarget({
      projectId: 'proj-a',
      directoryOverride: projectRoot,
    });

    const draft = useSessionUIStore.getState().newSessionDraft;
    expect(draft.directoryOverride).toBe(projectRoot);
    expect(draft.bootstrapPendingDirectory).toBe(worktreePath);
    expect(draft.preserveDirectoryOverride).toBe(true);
  });
});
