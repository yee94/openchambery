import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ASSIGN_CODES,
  PROJECT_REQUIRED_MESSAGE,
  assignSession,
  isManagedAssistantWorkspace,
  resolveAssignDirectory,
} from './assign.js';

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'assign-'));

describe('resolveAssignDirectory', () => {
  it('requires a registered project root', () => {
    expect(() => resolveAssignDirectory({ allowedRoots: [] })).toThrowError(
      expect.objectContaining({ code: ASSIGN_CODES.PROJECT_REQUIRED, message: PROJECT_REQUIRED_MESSAGE }),
    );
  });

  it('rejects managed assistant-workspaces even when they sit under an allowed root', () => {
    const directory = root();
    const managed = path.join(directory, 'assistant-workspaces', 'asst_1');
    fs.mkdirSync(managed, { recursive: true });
    expect(isManagedAssistantWorkspace(managed, path.join(directory, 'assistant-workspaces'))).toBe(true);
    expect(() => resolveAssignDirectory({
      directory: managed,
      allowedRoots: [directory],
      managedWorkspaceRoot: path.join(directory, 'assistant-workspaces'),
    })).toThrowError(expect.objectContaining({ code: ASSIGN_CODES.WORKSPACE_FORBIDDEN }));
  });

  it('resolves an existing worktree for a branch and refuses a missing one', () => {
    const directory = root();
    const project = path.join(directory, 'project');
    const worktree = path.join(directory, 'worktrees', 'login');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    expect(resolveAssignDirectory({
      projectPath: project,
      branch: 'feat-login',
      allowedRoots: [directory],
      managedWorkspaceRoot: path.join(directory, 'assistant-workspaces'),
      worktrees: [{ branch: 'feat-login', path: worktree }],
    })).toBe(fs.realpathSync(worktree));
    expect(() => resolveAssignDirectory({
      projectPath: project,
      branch: 'missing',
      allowedRoots: [directory],
      managedWorkspaceRoot: path.join(directory, 'assistant-workspaces'),
      worktrees: [{ branch: 'feat-login', path: worktree }],
    })).toThrowError(expect.objectContaining({ code: ASSIGN_CODES.WORKTREE_NOT_FOUND }));
  });
});

describe('assignSession', () => {
  it('creates a visible worker session and prompts it', async () => {
    const directory = root();
    const project = path.join(directory, 'app');
    fs.mkdirSync(project, { recursive: true });
    const createSession = vi.fn(async (input) => ({ data: { id: 'ses_worker' }, input }));
    const promptExisting = vi.fn(async () => ({ response: { status: 204 } }));
    const assigned = await assignSession({
      prompt: 'Fix login',
      projectPath: project,
      title: 'Login',
      assistant: { id: 'asst_1', name: 'Ada', providerID: 'openai', modelID: 'gpt-5.2' },
      allowedRoots: [directory],
      managedWorkspaceRoot: path.join(directory, 'assistant-workspaces'),
      createSession,
      promptExisting,
    });
    expect(assigned).toMatchObject({
      sessionID: 'ses_worker',
      directory: fs.realpathSync(project),
      title: 'Login',
      status: 'busy',
      reused: false,
    });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: fs.realpathSync(project),
      title: 'Login',
      metadata: {
        openchamber: {
          assigned: { from: 'contact', assistantID: 'asst_1', name: 'Ada' },
        },
      },
    }));
    expect(createSession.mock.calls[0][0].metadata.openchamber.assistant).toBeUndefined();
    expect(promptExisting).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_worker',
      directory: fs.realpathSync(project),
      parts: [{ type: 'text', text: 'Fix login' }],
      model: { providerID: 'openai', modelID: 'gpt-5.2' },
    }));
  });

  it('reuses an existing session without creating another', async () => {
    const directory = root();
    fs.mkdirSync(directory, { recursive: true });
    const createSession = vi.fn();
    const promptExisting = vi.fn(async () => ({ response: { status: 204 } }));
    const assigned = await assignSession({
      prompt: 'Continue login',
      sessionID: 'ses_existing',
      directory,
      assistant: { providerID: 'p', modelID: 'm' },
      allowedRoots: [directory],
      managedWorkspaceRoot: path.join(directory, 'assistant-workspaces'),
      createSession,
      promptExisting,
    });
    expect(assigned).toMatchObject({ sessionID: 'ses_existing', reused: true, status: 'busy' });
    expect(createSession).not.toHaveBeenCalled();
    expect(promptExisting).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'ses_existing' }));
  });
});
