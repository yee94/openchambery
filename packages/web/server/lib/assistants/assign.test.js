import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ASSIGN_CODES,
  PROJECT_REQUIRED_MESSAGE,
  assignSession,
  attachmentScopeKey,
  buildAssignParts,
  extractAssignSessionModel,
  hasAssignImageParts,
  isAmbiguousPromptFailure,
  isManagedAssistantWorkspace,
  normalizeAssignSessionModel,
  requireProvidedString,
  resolveAssignDirectory,
  resolveAssignWorkerModel,
  resolveAssignWorkerVariant,
  sanitizeAssignFileParts,
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

describe('requireProvidedString / resolveAssignWorkerModel', () => {
  const catalog = {
    models: [
      { providerID: 'openai', modelID: 'gpt-4o', name: 'GPT-4o', acceptsImages: true },
      { providerID: 'xai', modelID: 'grok-4.6', name: 'Grok 4.6', acceptsImages: true },
      { providerID: 'opencode-go', modelID: 'deepseek-v4-flash', name: 'deepseek-v4-flash', acceptsImages: false },
      { providerID: 'other', modelID: 'deepseek-v4-flash', name: 'clone', acceptsImages: false },
    ],
  };

  it('defaults to the assistant model without requiring catalog', () => {
    expect(resolveAssignWorkerModel({
      fallback: { providerID: 'p', modelID: 'm' },
    })).toEqual({
      providerID: 'p',
      modelID: 'm',
      source: 'assistant',
      name: null,
      acceptsImages: null,
    });
  });

  it('prefers a catalog-matched session model over the assistant default', () => {
    expect(normalizeAssignSessionModel({ providerID: 'xai', id: 'grok-4.6' })).toEqual({
      providerID: 'xai',
      modelID: 'grok-4.6',
    });
    expect(extractAssignSessionModel({
      session: { model: { providerID: 'xai', id: 'grok-4.6' } },
    })).toEqual({ providerID: 'xai', modelID: 'grok-4.6' });
    expect(extractAssignSessionModel({
      messages: [
        { info: { role: 'user', model: { providerID: 'openai', modelID: 'gpt-4o' } } },
        { info: { role: 'assistant', model: { providerID: 'xai', id: 'grok-4.6' } } },
      ],
    })).toEqual({ providerID: 'xai', modelID: 'grok-4.6' });
    expect(resolveAssignWorkerModel({
      sessionModel: { providerID: 'xai', modelID: 'grok-4.6' },
      fallback: { providerID: 'p', modelID: 'm' },
      catalog,
    })).toMatchObject({
      providerID: 'xai',
      modelID: 'grok-4.6',
      source: 'session',
      acceptsImages: true,
    });
  });

  it('degrades to the assistant model when the session model is missing from catalog', () => {
    expect(resolveAssignWorkerModel({
      sessionModel: { providerID: 'missing', modelID: 'gone' },
      fallback: { providerID: 'p', modelID: 'm' },
      catalog,
    })).toEqual({
      providerID: 'p',
      modelID: 'm',
      source: 'assistant',
      name: null,
      acceptsImages: null,
    });
    expect(resolveAssignWorkerModel({
      sessionModel: { providerID: 'xai', modelID: 'grok-4.6' },
      fallback: { providerID: 'p', modelID: 'm' },
      catalog: null,
    }).source).toBe('assistant');
  });

  it('keeps explicit model fail-closed over a session model', () => {
    expect(resolveAssignWorkerModel({
      model: 'openai/gpt-4o',
      sessionModel: { providerID: 'xai', modelID: 'grok-4.6' },
      fallback: { providerID: 'p', modelID: 'm' },
      catalog,
    })).toMatchObject({
      providerID: 'openai',
      modelID: 'gpt-4o',
      source: 'explicit',
    });
  });

  it('resolves explicit provider/model against the connected catalog', () => {
    expect(resolveAssignWorkerModel({
      model: 'xai/grok-4.6',
      fallback: { providerID: 'p', modelID: 'm' },
      catalog,
    })).toMatchObject({
      providerID: 'xai',
      modelID: 'grok-4.6',
      source: 'explicit',
      acceptsImages: true,
    });
  });

  it('fails closed for missing or ambiguous model names', () => {
    expect(() => resolveAssignWorkerModel({
      model: 'missing-model',
      fallback: { providerID: 'p', modelID: 'm' },
      catalog,
    })).toThrowError(expect.objectContaining({ code: ASSIGN_CODES.MODEL_NOT_FOUND }));
    expect(() => resolveAssignWorkerModel({
      modelID: 'deepseek-v4-flash',
      fallback: { providerID: 'p', modelID: 'm' },
      catalog,
    })).toThrowError(expect.objectContaining({ code: ASSIGN_CODES.MODEL_AMBIGUOUS }));
    expect(() => resolveAssignWorkerModel({
      model: 'xai/grok-4.6',
      fallback: { providerID: 'p', modelID: 'm' },
      catalog: null,
    })).toThrowError(expect.objectContaining({ code: ASSIGN_CODES.UPSTREAM }));
  });

  it('fails closed on illegal provided explicit model fields (no silent null fallback)', () => {
    expect(() => requireProvidedString({ x: 1 }, { field: 'model', max: 512 })).toThrowError(
      expect.objectContaining({ code: ASSIGN_CODES.VALIDATION }),
    );
    expect(() => requireProvidedString('x'.repeat(513), { field: 'model', max: 512 })).toThrowError(
      expect.objectContaining({ code: ASSIGN_CODES.VALIDATION, message: expect.stringMatching(/exceeds 512/) }),
    );
    expect(() => requireProvidedString('   ', { field: 'modelID', max: 256 })).toThrowError(
      expect.objectContaining({ code: ASSIGN_CODES.VALIDATION }),
    );
    expect(() => resolveAssignWorkerModel({
      model: 'x'.repeat(513),
      fallback: { providerID: 'p', modelID: 'm' },
      catalog,
    })).toThrowError(expect.objectContaining({ code: ASSIGN_CODES.VALIDATION }));
    expect(() => resolveAssignWorkerModel({
      model: { providerID: 'xai', modelID: 'grok-4.6' },
      fallback: { providerID: 'p', modelID: 'm' },
      catalog,
    })).toThrowError(expect.objectContaining({ code: ASSIGN_CODES.VALIDATION }));
    expect(() => resolveAssignWorkerModel({
      providerID: 'xai',
      modelID: 'grok-4.6',
      model: 'openai/gpt-4o',
      fallback: { providerID: 'p', modelID: 'm' },
      catalog,
    })).toThrowError(expect.objectContaining({
      code: ASSIGN_CODES.VALIDATION,
      message: expect.stringMatching(/conflicts/),
    }));
  });
});

describe('resolveAssignWorkerVariant', () => {
  it('reuses assistant variant only for same/default model; drops it cross-model', () => {
    expect(resolveAssignWorkerVariant({
      source: 'assistant',
      workerProviderID: 'p',
      workerModelID: 'm',
      assistant: { providerID: 'p', modelID: 'm', variant: 'fast' },
    })).toBe('fast');
    expect(resolveAssignWorkerVariant({
      source: 'explicit',
      workerProviderID: 'xai',
      workerModelID: 'grok-4.6',
      assistant: { providerID: 'p', modelID: 'm', variant: 'fast' },
    })).toBeNull();
    expect(resolveAssignWorkerVariant({
      source: 'explicit',
      workerProviderID: 'xai',
      workerModelID: 'grok-4.6',
      assistant: { providerID: 'p', modelID: 'm', variant: 'fast' },
      variant: 'default',
    })).toBe('default');
    expect(() => resolveAssignWorkerVariant({
      source: 'explicit',
      workerProviderID: 'xai',
      workerModelID: 'grok-4.6',
      variant: 'x'.repeat(300),
    })).toThrowError(expect.objectContaining({ code: ASSIGN_CODES.VALIDATION }));
  });
});

describe('assign file parts', () => {
  it('keeps attachment order and fingerprints content without exposing file data', () => {
    const first = { type: 'file', mime: 'text/plain', filename: 'first.txt', url: 'data:text/plain;base64,Zmlyc3Q=' };
    const second = { ...first, filename: 'second.txt', url: 'data:text/plain;base64,c2Vjb25k' };
    const key = attachmentScopeKey([first, second]);
    expect(key).toEqual(attachmentScopeKey([{ ...first }, { ...second }]));
    expect(key).not.toEqual(attachmentScopeKey([second, first]));
    expect(JSON.stringify(key)).not.toContain(first.url);
    expect(JSON.stringify(key)).not.toContain(first.filename);
  });
  it('sanitizes file parts and builds prompt+file worker parts', () => {
    const image = { type: 'file', mime: 'image/png', url: 'data:image/png;base64,aa', filename: 'shot.png' };
    const bad = { type: 'file', mime: 'image/png' };
    expect(sanitizeAssignFileParts([image, bad, { type: 'text', text: 'x' }])).toEqual([image]);
    expect(hasAssignImageParts([image])).toBe(true);
    expect(buildAssignParts({ prompt: 'Fix width', fileParts: [image] })).toEqual([
      { type: 'text', text: 'Fix width' },
      image,
    ]);
    expect(attachmentScopeKey([image])).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
    expect(JSON.stringify(attachmentScopeKey([image]))).not.toContain('base64');
  });
});

describe('isAmbiguousPromptFailure', () => {
  it('treats transport/5xx/no-status as ambiguous and 4xx as definite', () => {
    expect(isAmbiguousPromptFailure(Object.assign(new Error('fetch failed'), { name: 'TypeError' }), null)).toBe(true);
    expect(isAmbiguousPromptFailure(null, { error: { status: 500 }, response: { status: 500 } })).toBe(true);
    expect(isAmbiguousPromptFailure(null, { error: { status: 400 }, response: { status: 400 } })).toBe(false);
    expect(isAmbiguousPromptFailure(null, { response: { status: 204 } })).toBe(false);
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
      model: { providerID: 'openai', modelID: 'gpt-5.2' },
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

  it('forwards current-turn images into promptAsync with an explicit vision model', async () => {
    const directory = root();
    fs.mkdirSync(directory, { recursive: true });
    const image = { type: 'file', mime: 'image/png', url: 'data:image/png;base64,aa', filename: 'card.png' };
    const createSession = vi.fn(async () => ({ data: { id: 'ses_img' } }));
    const promptExisting = vi.fn(async () => ({ response: { status: 204 } }));
    const assigned = await assignSession({
      prompt: 'Fix mobile card width from this screenshot',
      directory,
      assistant: { id: 'asst_1', name: 'Ada', providerID: 'p', modelID: 'm', variant: 'fast' },
      model: { providerID: 'xai', modelID: 'grok-4.6', acceptsImages: true },
      fileParts: [image],
      allowedRoots: [directory],
      managedWorkspaceRoot: path.join(directory, 'assistant-workspaces'),
      createSession,
      promptExisting,
    });
    expect(assigned.model).toEqual({ providerID: 'xai', modelID: 'grok-4.6' });
    expect(promptExisting).toHaveBeenCalledWith(expect.objectContaining({
      model: { providerID: 'xai', modelID: 'grok-4.6' },
      parts: [
        { type: 'text', text: 'Fix mobile card width from this screenshot' },
        image,
      ],
    }));
    // Cross-model must not reuse contact-only variant.
    expect(promptExisting.mock.calls[0][0].variant).toBeUndefined();
  });

  it('reuses assistant variant only when the worker model matches the contact', async () => {
    const directory = root();
    fs.mkdirSync(directory, { recursive: true });
    const promptExisting = vi.fn(async () => ({ response: { status: 204 } }));
    await assignSession({
      prompt: 'Fix',
      directory,
      assistant: { providerID: 'p', modelID: 'm', variant: 'fast' },
      allowedRoots: [directory],
      managedWorkspaceRoot: path.join(directory, 'assistant-workspaces'),
      createSession: async () => ({ data: { id: 'ses_var' } }),
      promptExisting,
    });
    expect(promptExisting).toHaveBeenCalledWith(expect.objectContaining({ variant: 'fast' }));
  });

  it('rejects image attachments for non-vision worker models before create', async () => {
    const directory = root();
    fs.mkdirSync(directory, { recursive: true });
    const createSession = vi.fn();
    await expect(assignSession({
      prompt: 'Look at this',
      directory,
      assistant: { providerID: 'p', modelID: 'm' },
      model: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash', acceptsImages: false },
      fileParts: [{ type: 'file', mime: 'image/png', url: 'data:image/png;base64,aa', filename: 'x.png' }],
      allowedRoots: [directory],
      managedWorkspaceRoot: path.join(directory, 'assistant-workspaces'),
      createSession,
      promptExisting: vi.fn(),
    })).rejects.toMatchObject({ code: ASSIGN_CODES.IMAGE_NOT_SUPPORTED });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('deletes a newly created worker on definite prompt failure (4xx)', async () => {
    const directory = root();
    fs.mkdirSync(directory, { recursive: true });
    const createSession = vi.fn(async () => ({ data: { id: 'ses_orphan' } }));
    const promptExisting = vi.fn(async () => ({ error: { status: 400 }, response: { status: 400 } }));
    const deleteSession = vi.fn(async () => ({ data: true }));
    await expect(assignSession({
      prompt: 'Fix',
      directory,
      assistant: { providerID: 'p', modelID: 'm' },
      allowedRoots: [directory],
      managedWorkspaceRoot: path.join(directory, 'assistant-workspaces'),
      createSession,
      promptExisting,
      deleteSession,
    })).rejects.toMatchObject({ code: ASSIGN_CODES.UPSTREAM });
    expect(deleteSession).toHaveBeenCalledWith({
      sessionID: 'ses_orphan',
      directory: fs.realpathSync(directory),
    });
  });

  it('does not delete on ambiguous prompt network/5xx; marks prompt_ambiguous with sessionID', async () => {
    const directory = root();
    fs.mkdirSync(directory, { recursive: true });
    const createSession = vi.fn(async () => ({ data: { id: 'ses_maybe' } }));
    const promptExisting = vi.fn(async () => {
      throw Object.assign(new Error('fetch failed'), { name: 'TypeError' });
    });
    const deleteSession = vi.fn(async () => ({ data: true }));
    await expect(assignSession({
      prompt: 'Fix',
      directory,
      messageID: 'msg_assign_fixed',
      assistant: { providerID: 'p', modelID: 'm' },
      allowedRoots: [directory],
      managedWorkspaceRoot: path.join(directory, 'assistant-workspaces'),
      createSession,
      promptExisting,
      deleteSession,
    })).rejects.toMatchObject({
      code: ASSIGN_CODES.PROMPT_AMBIGUOUS,
      ambiguous: true,
      sessionID: 'ses_maybe',
      messageID: 'msg_assign_fixed',
    });
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('confirms ambiguous prompt via lookupMessage instead of deleting or recreating', async () => {
    const directory = root();
    fs.mkdirSync(directory, { recursive: true });
    const promptExisting = vi.fn(async () => ({ error: { status: 503 }, response: { status: 503 } }));
    const deleteSession = vi.fn();
    const lookupMessage = vi.fn(async () => ({ found: true, id: 'msg_assign_ok' }));
    const assigned = await assignSession({
      prompt: 'Fix',
      directory,
      messageID: 'msg_assign_ok',
      assistant: { providerID: 'p', modelID: 'm' },
      allowedRoots: [directory],
      managedWorkspaceRoot: path.join(directory, 'assistant-workspaces'),
      createSession: async () => ({ data: { id: 'ses_confirmed' } }),
      promptExisting,
      deleteSession,
      lookupMessage,
    });
    expect(assigned).toMatchObject({
      sessionID: 'ses_confirmed',
      messageID: 'msg_assign_ok',
      promptStatus: 'confirmed',
    });
    expect(deleteSession).not.toHaveBeenCalled();
    expect(lookupMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_confirmed',
      messageID: 'msg_assign_ok',
    }));
  });

  it.each([false, true])('confirms an ambiguous response for reused=%s through one admission path', async (reused) => {
    const directory = root();
    const deleteSession = vi.fn();
    const createSession = vi.fn(async () => ({ data: { id: 'ses_common' } }));
    const result = await assignSession({
      prompt: 'Fix', directory, allowedRoots: [directory],
      assistant: { providerID: 'p', modelID: 'm' },
      ...(reused ? { sessionID: 'ses_common' } : {}),
      createSession, deleteSession,
      promptExisting: async () => ({ error: { status: 503 } }),
      lookupMessage: async () => ({ found: true }),
    });
    expect(result).toMatchObject({ sessionID: 'ses_common', reused, promptStatus: 'confirmed' });
    expect(createSession).toHaveBeenCalledTimes(reused ? 0 : 1);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it.each([false, true])('cleans up only new workers after definite rejection, reused=%s', async (reused) => {
    const directory = root();
    const deleteSession = vi.fn();
    await expect(assignSession({
      prompt: 'Fix', directory, allowedRoots: [directory],
      assistant: { providerID: 'p', modelID: 'm' },
      ...(reused ? { sessionID: 'ses_common' } : {}),
      createSession: async () => ({ data: { id: 'ses_common' } }),
      deleteSession,
      promptExisting: async () => ({ error: { status: 400 } }),
    })).rejects.toMatchObject({ code: ASSIGN_CODES.UPSTREAM });
    expect(deleteSession).toHaveBeenCalledTimes(reused ? 0 : 1);
  });

  it('bounds create/prompt with deadlines', async () => {
    const directory = root();
    fs.mkdirSync(directory, { recursive: true });
    await expect(assignSession({
      prompt: 'Fix',
      directory,
      assistant: { providerID: 'p', modelID: 'm' },
      allowedRoots: [directory],
      managedWorkspaceRoot: path.join(directory, 'assistant-workspaces'),
      createTimeoutMs: 20,
      createSession: async () => new Promise(() => {}),
      promptExisting: vi.fn(),
    })).rejects.toMatchObject({ code: ASSIGN_CODES.UPSTREAM, message: expect.stringMatching(/timed out/) });
  });

  it('reuses an existing session without creating another', async () => {
    const directory = root();
    fs.mkdirSync(directory, { recursive: true });
    const createSession = vi.fn();
    const promptExisting = vi.fn(async () => ({ response: { status: 204 } }));
    const deleteSession = vi.fn();
    const assigned = await assignSession({
      prompt: 'Continue login',
      sessionID: 'ses_existing',
      directory,
      assistant: { providerID: 'p', modelID: 'm' },
      allowedRoots: [directory],
      managedWorkspaceRoot: path.join(directory, 'assistant-workspaces'),
      createSession,
      promptExisting,
      deleteSession,
    });
    expect(assigned).toMatchObject({ sessionID: 'ses_existing', reused: true, status: 'busy' });
    expect(createSession).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
    expect(promptExisting).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'ses_existing' }));
  });
});
