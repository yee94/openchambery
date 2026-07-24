/**
 * Utilities for creating worktrees and, when needed, sessions bound to them.
 * This is a standalone entrypoint for keyboard shortcuts, menu actions,
 * and other non-hook contexts.
 */

import { toast } from '@/components/ui';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getConfigDirectoryKey, useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSelectionStore } from '@/sync/selection-store';
import { checkIsGitRepository, previewGitWorktree } from '@/lib/gitApi';
import { generateBranchName } from '@/lib/git/branchNameGenerator';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';
import { getWorktreeSetupCommands, getWorktreeSetupWaitEnabled } from '@/lib/openchamberConfig';
import {
  removeProjectWorktree,
  type ProjectRef,
} from '@/lib/worktrees/worktreeManager';
import { createWorktreeWithDefaults } from '@/lib/worktrees/worktreeCreate';
import {
  createPendingDraftWorktreeRequest,
  rejectPendingDraftWorktreeRequest,
  resolvePendingDraftWorktreeRequest,
} from '@/lib/worktrees/pendingDraftWorktree';
import { waitForWorktreeBootstrap } from '@/lib/worktrees/worktreeBootstrap';

const normalizePath = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '') || value;

/** Snapshot of live config selection after Project defaults are applied. */
export type WorktreeSessionSelectionSnapshot = {
  agentName?: string;
  providerId?: string;
  modelId?: string;
  variant?: string;
};

export const readWorktreeSessionSelectionSnapshot = (config: {
  currentAgentName?: string;
  currentProviderId?: string;
  currentModelId?: string;
  currentVariant?: string;
}): WorktreeSessionSelectionSnapshot => ({
  agentName: config.currentAgentName,
  providerId: config.currentProviderId,
  modelId: config.currentModelId,
  variant: config.currentVariant,
});

/**
 * Persist a complete selection snapshot into session memory.
 * Variant is always written (including undefined) so a clear is explicit.
 */
export const writeWorktreeSessionSelection = (
  sessionId: string,
  snapshot: WorktreeSessionSelectionSnapshot,
  memory: {
    saveSessionAgentSelection: (sessionId: string, agentName: string) => void;
    saveSessionModelSelection: (sessionId: string, providerId: string, modelId: string) => void;
    saveAgentModelForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => void;
    saveAgentModelVariantForSession: (
      sessionId: string,
      agentName: string,
      providerId: string,
      modelId: string,
      variant: string | undefined,
    ) => void;
  },
): void => {
  const agentName = snapshot.agentName?.trim() || undefined;
  const providerId = snapshot.providerId?.trim() || undefined;
  const modelId = snapshot.modelId?.trim() || undefined;
  if (!agentName || !providerId || !modelId) {
    return;
  }
  memory.saveSessionAgentSelection(sessionId, agentName);
  memory.saveSessionModelSelection(sessionId, providerId, modelId);
  memory.saveAgentModelForSession(sessionId, agentName, providerId, modelId);
  memory.saveAgentModelVariantForSession(sessionId, agentName, providerId, modelId, snapshot.variant);
};

const waitForWorktreeBootstrapIfEnabled = async (project: ProjectRef, directory: string): Promise<void> => {
  if (await getWorktreeSetupWaitEnabled(project)) {
    await waitForWorktreeBootstrap(directory);
  }
};

const resolveProjectRef = (directory: string): ProjectRef | null => {
  const normalized = normalizePath(directory);
  const projects = useProjectsStore.getState().projects;
  if (projects.length === 0) {
    return null;
  }

  const activeProject = useProjectsStore.getState().getActiveProject();
  if (activeProject?.path) {
    const activePath = normalizePath(activeProject.path);
    if (normalized === activePath || normalized.startsWith(`${activePath}/`)) {
      return { id: activeProject.id, path: activeProject.path };
    }
  }

  const matches = projects.filter((project) => {
    const projectPath = normalizePath(project.path);
    return normalized === projectPath || normalized.startsWith(`${projectPath}/`);
  });

  const match = matches.sort((a, b) => normalizePath(b.path).length - normalizePath(a.path).length)[0];

  return match ? { id: match.id, path: match.path } : null;
};

// Track if a worktree creation flow is already running
let isCreatingWorktreeSession = false;

/**
 * Activate owning Project config, apply Project-aware defaults, then write the
 * resulting selection into session memory. Cross-Project inheritance is blocked
 * by activating projectRef.path before applyDefaultModelAgentSelection.
 */
const applyProjectDefaultSelectionForWorktreeSession = async (
  sessionId: string,
  projectRef: ProjectRef,
): Promise<void> => {
  try {
    const project = useProjectsStore.getState().projects.find((entry) => entry.id === projectRef.id)
      ?? useProjectsStore.getState().projects.find((entry) => normalizePath(entry.path) === normalizePath(projectRef.path));
    const expectedKey = getConfigDirectoryKey(projectRef.path);
    await useConfigStore.getState().activateDirectory(projectRef.path, {
      refreshProviders: true,
      source: 'worktreeSessionCreator',
    });
    const afterActivate = useConfigStore.getState();
    // Catalog/activation failure must not apply another Project's live selection.
    if (afterActivate.activeDirectoryKey !== expectedKey) {
      return;
    }
    if (afterActivate.providers.length === 0 || afterActivate.agents.length === 0) {
      return;
    }
    afterActivate.applyDefaultModelAgentSelection({
      projectDefaultModel: project?.defaultModel ?? undefined,
    });
    const snapshot = readWorktreeSessionSelectionSnapshot(useConfigStore.getState());
    writeWorktreeSessionSelection(sessionId, snapshot, useSelectionStore.getState());
  } catch {
    // Ignore selection errors; session remains usable with empty memory.
  }
};

const initializeSessionForWorktree = async (
  sessionId: string,
  metadata: {
    path: string;
    projectDirectory: string;
    branch: string;
    label: string;
    name?: string;
    createdFromBranch?: string;
    kind?: 'pr' | 'standard';
  },
  projectRef: ProjectRef,
) => {
  const sessionStore = useSessionUIStore.getState();
  const configState = useConfigStore.getState();
  sessionStore.initializeNewOpenChamberSession(sessionId, configState.agents);
  sessionStore.setSessionDirectory(sessionId, metadata.path);
  sessionStore.setWorktreeMetadata(sessionId, metadata);
  await applyProjectDefaultSelectionForWorktreeSession(sessionId, projectRef);
  useDirectoryStore.getState().setDirectory(metadata.path, { showOverlay: false });
};


type InstantWorktreeDraftOptions = {
  initialPrompt?: string;
  title?: string;
  /** When set, create a worktree for this existing branch instead of generating a new one. */
  existingBranch?: string;
  projectDirectory?: string;
};

const slugifyWorktreeName = (value: string): string => {
  return value
    .trim()
    .replace(/^remotes\//, '')
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/\/+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'worktree';
};

const createInstantWorktreeDraft = async (options?: InstantWorktreeDraftOptions): Promise<string | null> => {
  if (isCreatingWorktreeSession) {
    return null;
  }

  const activeProject = useProjectsStore.getState().getActiveProject();
  const projectDirectory = options?.projectDirectory?.trim() || activeProject?.path;
  if (!projectDirectory) {
    toast.error('No active project', {
      description: 'Please select a project first.',
    });
    return null;
  }

  const projectRef = resolveProjectRef(projectDirectory) ?? (
    activeProject?.path
      ? { id: activeProject.id, path: activeProject.path }
      : null
  );
  if (!projectRef) {
    toast.error('No active project', {
      description: 'Please select a project first.',
    });
    return null;
  }

  let isGitRepo = false;
  try {
    isGitRepo = await checkIsGitRepository(projectRef.path);
  } catch {
    // Ignore errors, treat as not a git repo
  }

  if (!isGitRepo) {
    toast.error('Not a Git repository', {
      description: 'Worktrees can only be created in Git repositories.',
    });
    return null;
  }

  isCreatingWorktreeSession = true;

  try {
    const pendingRequestId = createPendingDraftWorktreeRequest();
    const existingBranch = options?.existingBranch?.trim().replace(/^remotes\//, '') || '';
    const preferredName = existingBranch
      ? slugifyWorktreeName(existingBranch)
      : generateBranchName();
    const mode = existingBranch ? 'existing' as const : 'new' as const;

    // Lock the draft immediately so no React effect can reset it to the project
    // root while we await the preview / worktree creation below.
    const sessionStore = useSessionUIStore.getState();
    if (sessionStore.newSessionDraft?.open) {
      sessionStore.overrideNewSessionDraftTarget({
        projectId: projectRef.id,
        directoryOverride: sessionStore.newSessionDraft.directoryOverride ?? projectRef.path,
        pendingWorktreeRequestId: pendingRequestId,
        preserveDirectoryOverride: true,
        title: options?.title,
        initialPrompt: options?.initialPrompt,
      });
    } else {
      sessionStore.openNewSessionDraft({
        selectedProjectId: projectRef.id,
        directoryOverride: projectRef.path,
        pendingWorktreeRequestId: pendingRequestId,
        preserveDirectoryOverride: true,
        title: options?.title,
        initialPrompt: options?.initialPrompt,
      });
    }

    const preview = await previewGitWorktree(projectRef.path, {
      mode,
      ...(mode === 'new'
        ? { branchName: preferredName, worktreeName: preferredName }
        : { existingBranch, worktreeName: preferredName }),
    }).catch(() => null);

    // Refine draft target once we know the actual worktree path from the preview.
    if (preview?.path) {
      useSessionUIStore.getState().overrideNewSessionDraftTarget({
        projectId: projectRef.id,
        directoryOverride: preview.path,
        pendingWorktreeRequestId: pendingRequestId,
        bootstrapPendingDirectory: preview.path,
        preserveDirectoryOverride: true,
        title: options?.title,
        initialPrompt: options?.initialPrompt,
      });
      useDirectoryStore.getState().setDirectory(preview.path, { showOverlay: false });
    }

    const setupCommands = await getWorktreeSetupCommands(projectRef);
    const metadata = await createWorktreeWithDefaults(projectRef, {
      preferredName,
      mode,
      worktreeName: preferredName,
      setupCommands,
      returnAfterDirectoryCreated: true,
      ...(mode === 'new'
        ? { branchName: preferredName }
        : { existingBranch }),
    });

    resolvePendingDraftWorktreeRequest(pendingRequestId, metadata.path);
    useSessionUIStore.getState().overrideNewSessionDraftTarget({
      projectId: projectRef.id,
      directoryOverride: metadata.path,
      pendingWorktreeRequestId: null,
      bootstrapPendingDirectory: metadata.path,
      preserveDirectoryOverride: true,
      title: options?.title,
      initialPrompt: options?.initialPrompt,
    });
    useDirectoryStore.getState().setDirectory(metadata.path, { showOverlay: false });

    return metadata.path;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create worktree';
    const requestId = useSessionUIStore.getState().newSessionDraft.pendingWorktreeRequestId;
    if (requestId) {
      rejectPendingDraftWorktreeRequest(requestId, error instanceof Error ? error : new Error(message));
      useSessionUIStore.getState().resolvePendingDraftWorktreeTarget(requestId, null);
    }
    useSessionUIStore.getState().setDraftBootstrapPendingDirectory(null);
    toast.error('Failed to create worktree', {
      description: message,
    });
    return null;
  } finally {
    isCreatingWorktreeSession = false;
  }
};

/**
 * Create a new worktree and open a draft scoped to it.
 * 
 * @returns The worktree path, or null if creation failed
 */
export async function createWorktreeSession(): Promise<string | null> {
  return createInstantWorktreeDraft();
}

/**
 * Check if a worktree session is currently being created.
 */
export async function createWorktreeDraft(options?: { initialPrompt?: string; title?: string }): Promise<string | null> {
  return createInstantWorktreeDraft(options);
}

/**
 * Create a draft-scoped worktree checked out to an existing branch.
 */
export async function createWorktreeDraftForBranch(options: {
  branch: string;
  projectDirectory?: string;
  initialPrompt?: string;
  title?: string;
}): Promise<string | null> {
  const branch = options.branch?.trim();
  if (!branch) {
    return null;
  }
  return createInstantWorktreeDraft({
    existingBranch: branch,
    projectDirectory: options.projectDirectory,
    initialPrompt: options.initialPrompt,
    title: options.title,
  });
}

/**
 * Create a worktree session for a new branch name.
 * Callers can still use startPoint for metadata or follow-up git operations.
 */
export async function createWorktreeSessionForNewBranch(
  projectDirectory: string,
  preferredBranchName: string,
  startPoint?: string,
  options?: {
    kind?: 'pr' | 'standard';
    worktreeName?: string;
    setUpstream?: boolean;
    upstreamRemote?: string;
    upstreamBranch?: string;
    ensureRemoteName?: string;
    ensureRemoteUrl?: string;
    createdFromBranch?: string;
    returnAfterDirectoryCreated?: boolean;
  }
): Promise<{ id: string; branch: string; path: string } | null> {
  if (isCreatingWorktreeSession) {
    return null;
  }

  isCreatingWorktreeSession = true;

  try {
    const start = startPoint?.trim() || 'HEAD';
    const base = preferredBranchName?.trim();
    if (!base) {
      throw new Error('Branch name is required');
    }

    const kind = options?.kind ?? 'standard';

    const projectRef = resolveProjectRef(projectDirectory);
    if (!projectRef) {
      throw new Error('Project is not registered in OpenChamber');
    }

    let isGitRepo = false;
    try {
      isGitRepo = await checkIsGitRepository(projectRef.path);
    } catch {
      // ignore
    }

    if (!isGitRepo) {
      toast.error('Not a Git repository', {
        description: 'Worktrees can only be created in Git repositories.',
      });
      return null;
    }

    const setupCommands = await getWorktreeSetupCommands(projectRef);
    const rootBranch = await getRootBranch(projectRef.path);
    try {
      const metadata = await createWorktreeWithDefaults(projectRef, {
        preferredName: base,
        mode: 'new',
        branchName: base,
        worktreeName: options?.worktreeName || base,
        startRef: start,
        setUpstream: options?.setUpstream,
        upstreamRemote: options?.upstreamRemote,
        upstreamBranch: options?.upstreamBranch,
        ensureRemoteName: options?.ensureRemoteName,
        ensureRemoteUrl: options?.ensureRemoteUrl,
        setupCommands,
        returnAfterDirectoryCreated: options?.returnAfterDirectoryCreated,
      });
      const createdMetadata = {
        ...metadata,
        createdFromBranch: options?.createdFromBranch || rootBranch || start,
        kind,
      };

      await waitForWorktreeBootstrapIfEnabled(projectRef, metadata.path);

      const sessionStore = useSessionUIStore.getState();
      const session = await sessionStore.createSession(undefined, metadata.path);
      if (!session) {
        await removeProjectWorktree(projectRef, metadata, { deleteLocalBranch: true }).catch(() => undefined);
        throw new Error('Could not create a session for the worktree.');
      }

      await initializeSessionForWorktree(session.id, createdMetadata, projectRef);

      return { id: session.id, branch: metadata.branch || base, path: metadata.path };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create worktree session';
      toast.error('Failed to create worktree', { description: message });
      return null;
    }
  } finally {
    isCreatingWorktreeSession = false;
  }
}
