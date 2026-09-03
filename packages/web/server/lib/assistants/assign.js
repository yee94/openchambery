import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class AssignError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AssignError';
    this.code = code;
  }
}

export const ASSIGN_CODES = Object.freeze({
  PROJECT_REQUIRED: 'project_required',
  WORKSPACE_FORBIDDEN: 'workspace_forbidden',
  WORKTREE_NOT_FOUND: 'worktree_not_found',
  VALIDATION: 'validation_error',
  UPSTREAM: 'upstream_error',
});

export const PROJECT_REQUIRED_MESSAGE = 'No registered project is configured. Add a project in Settings before assigning work. Do not use assistant-workspaces.';

const contained = (candidate, root) => candidate === root || candidate.startsWith(`${root}${path.sep}`);

const trim = (value, max = 10_000) => {
  if (typeof value !== 'string') return null;
  const next = value.trim();
  if (!next || next.length > max) return null;
  return next;
};

const promptAdmitted = (result) => (
  !result?.error
  && (result?.response?.status === 204 || result?.status === 204 || result?.data !== undefined || result?.response?.ok === true)
);

function normalizeProjectRoots(allowedRoots = []) {
  const seen = new Set();
  const roots = [];
  for (const root of allowedRoots) {
    if (typeof root !== 'string' || !root.trim()) continue;
    const resolved = path.resolve(root.trim());
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    roots.push(resolved);
  }
  return roots;
}

export function isManagedAssistantWorkspace(candidate, managedWorkspaceRoot) {
  if (!candidate || !managedWorkspaceRoot) return false;
  return contained(path.resolve(candidate), path.resolve(managedWorkspaceRoot));
}

export function resolveAssignDirectory({
  projectPath,
  directory,
  branch,
  allowedRoots,
  managedWorkspaceRoot,
  defaultProjectPath = null,
  worktrees = [],
}) {
  const roots = normalizeProjectRoots(allowedRoots);
  if (roots.length === 0) {
    throw new AssignError(ASSIGN_CODES.PROJECT_REQUIRED, PROJECT_REQUIRED_MESSAGE);
  }

  const rejectManaged = (resolved) => {
    if (isManagedAssistantWorkspace(resolved, managedWorkspaceRoot)) {
      throw new AssignError(
        ASSIGN_CODES.WORKSPACE_FORBIDDEN,
        'Assign cannot use assistant-workspaces. Choose a registered project path.',
      );
    }
  };

  const underRoots = (resolved) => roots.some((root) => contained(resolved, root));

  const resolveExisting = (candidate) => {
    const raw = trim(candidate, 4096);
    if (!raw) return null;
    const resolved = path.resolve(raw);
    rejectManaged(resolved);
    if (!underRoots(resolved)) {
      throw new AssignError(
        ASSIGN_CODES.WORKSPACE_FORBIDDEN,
        'That path is not a registered project. Add it in Settings, then assign again.',
      );
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new AssignError(ASSIGN_CODES.VALIDATION, 'The project directory does not exist.');
    }
    try {
      return fs.realpathSync(resolved);
    } catch {
      throw new AssignError(ASSIGN_CODES.VALIDATION, 'The project directory does not exist.');
    }
  };

  let target = resolveExisting(directory) || resolveExisting(projectPath) || resolveExisting(defaultProjectPath);

  if (!target && roots.length === 1) {
    rejectManaged(roots[0]);
    if (fs.existsSync(roots[0]) && fs.statSync(roots[0]).isDirectory()) {
      target = fs.realpathSync(roots[0]);
    }
  }

  if (!target) {
    throw new AssignError(
      ASSIGN_CODES.PROJECT_REQUIRED,
      'Choose a registered project path. Several projects are configured; assign cannot guess.',
    );
  }

  const branchName = trim(branch, 256);
  if (!branchName) return target;

  const match = (Array.isArray(worktrees) ? worktrees : []).find((entry) => {
    const entryBranch = trim(entry?.branch, 256);
    if (!entryBranch) return false;
    return entryBranch === branchName || entryBranch === `refs/heads/${branchName}`;
  });
  if (!match?.path) {
    throw new AssignError(
      ASSIGN_CODES.WORKTREE_NOT_FOUND,
      `No existing worktree is checked out on ${branchName}. Create that worktree in Chat first, then assign again.`,
    );
  }
  return resolveExisting(match.path);
}

export async function assignSession(input = {}) {
  const prompt = trim(input.prompt, 200_000);
  if (!prompt) {
    throw new AssignError(ASSIGN_CODES.VALIDATION, 'assign_session requires a coding prompt for the worker session.');
  }

  const projectDirectory = resolveAssignDirectory({
    projectPath: input.projectPath,
    directory: input.directory,
    branch: null,
    allowedRoots: input.allowedRoots,
    managedWorkspaceRoot: input.managedWorkspaceRoot,
    defaultProjectPath: input.defaultProjectPath,
    worktrees: [],
  });

  let directory = projectDirectory;
  const branchName = trim(input.branch, 256);
  if (branchName && !trim(input.directory, 4096)) {
    const worktrees = typeof input.listWorktrees === 'function'
      ? await input.listWorktrees(projectDirectory)
      : (input.worktrees || []);
    directory = resolveAssignDirectory({
      projectPath: projectDirectory,
      directory: projectDirectory,
      branch: branchName,
      allowedRoots: input.allowedRoots,
      managedWorkspaceRoot: input.managedWorkspaceRoot,
      worktrees,
    });
  }

  const assistant = input.assistant && typeof input.assistant === 'object' ? input.assistant : {};
  const providerID = trim(assistant.providerID, 256);
  const modelID = trim(assistant.modelID, 256);
  if (!providerID || !modelID) {
    throw new AssignError(ASSIGN_CODES.VALIDATION, 'Assistant is missing a connected provider/model.');
  }

  const sessionID = trim(input.sessionID, 256);
  const title = trim(input.title, 256) || prompt.slice(0, 80);
  const messageID = trim(input.messageID, 256) || `msg_assign_${crypto.randomUUID()}`;
  const model = { providerID, modelID };
  const parts = [{ type: 'text', text: prompt }];
  const metadata = {
    openchamber: {
      assistant: {
        assistantID: assistant.id || assistant.assistantID || null,
        name: assistant.name || null,
      },
      assigned: { from: 'contact' },
    },
  };
  const promptInput = {
    directory,
    messageID,
    model,
    parts,
    ...(trim(assistant.agent, 256) ? { agent: trim(assistant.agent, 256) } : {}),
    ...(trim(assistant.variant, 256) ? { variant: trim(assistant.variant, 256) } : {}),
  };

  if (sessionID) {
    if (typeof input.promptExisting !== 'function') {
      throw new AssignError(ASSIGN_CODES.UPSTREAM, 'Worker prompt is unavailable.');
    }
    const prompted = await input.promptExisting({ ...promptInput, sessionID });
    if (!promptAdmitted(prompted)) {
      throw new AssignError(ASSIGN_CODES.UPSTREAM, 'Failed to submit the prompt to the existing session.');
    }
    return { sessionID, directory, title, status: 'busy', reused: true, messageID };
  }

  if (typeof input.createSession !== 'function' || typeof input.promptExisting !== 'function') {
    throw new AssignError(ASSIGN_CODES.UPSTREAM, 'Worker session APIs are unavailable.');
  }

  const created = await input.createSession({ directory, title, metadata });
  const createdID = created?.data?.id || created?.id;
  if (created?.error || !createdID) {
    throw new AssignError(ASSIGN_CODES.UPSTREAM, 'Failed to create a coding session.');
  }

  const prompted = await input.promptExisting({ ...promptInput, sessionID: createdID });
  if (!promptAdmitted(prompted)) {
    throw new AssignError(ASSIGN_CODES.UPSTREAM, 'Failed to submit the prompt to the new session.');
  }

  return { sessionID: createdID, directory, title, status: 'busy', reused: false, messageID };
}
