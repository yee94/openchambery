import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gitService = vi.hoisted(() => ({
  removeWorktree: vi.fn(),
  stageGitFiles: vi.fn(),
  unstageGitFiles: vi.fn(),
  checkoutCommit: vi.fn(),
  cherryPick: vi.fn(),
  revertCommit: vi.fn(),
  resetToCommit: vi.fn(),
  // Keep the special-runtime gitService surface present so shared importers
  // never see a partial mock, even if registries merge.
  getGitRangeFiles: vi.fn(),
  getGitRangeDiff: vi.fn(),
}));

vi.mock('./gitService', () => gitService);

const { handleStandardGitBridgeMessage } = await import('./bridge-git-runtime');

describe('worktree deletion resource release', () => {
  afterEach(() => vi.unstubAllGlobals());
  const message = { id: 'delete', type: 'api:git/worktrees', payload: { directory: '/repo', method: 'DELETE', body: { directory: '/repo/worktree' } } };
  it('uses host URL/auth and continues after release failure', async () => {
    const requests = [];
    vi.stubGlobal('fetch', async (input, init) => {
      requests.push(new Request(input, init));
      return new Response('{}', { status: 503 });
    });
    gitService.removeWorktree.mockImplementation(async (_root, _input, options) => {
      await options.beforeRemove('/repo/worktree');
      return true;
    });
    const result = await handleStandardGitBridgeMessage(message, { manager: {
      getApiUrl: () => 'https://host.invalid', getOpenCodeAuthHeaders: () => ({ Authorization: 'test-host-auth' }),
    } });
    expect(result.data).toEqual({ success: true, locationRelease: { state: 'failed' } });
    expect(requests[0].headers.get('Authorization')).toBe('test-host-auth');
    expect(new URL(requests[0].url).searchParams.get('location[directory]')).toBe('/repo/worktree');
  });
  it('does not report removal success after a Git failure', async () => {
    gitService.removeWorktree.mockImplementation(async (_root, _input, options) => {
      await options.beforeRemove('/repo/worktree');
      throw new Error('file still occupied');
    });
    await expect(handleStandardGitBridgeMessage(message)).rejects.toThrow('file still occupied');
  });
});

describe('bridge git runtime index mutations', () => {
  beforeEach(() => {
    gitService.stageGitFiles.mockReset();
    gitService.unstageGitFiles.mockReset();
    gitService.checkoutCommit.mockReset();
    gitService.cherryPick.mockReset();
    gitService.revertCommit.mockReset();
    gitService.resetToCommit.mockReset();
  });

  it('accepts legacy stage path payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/stage',
      payload: { directory: '/repo', path: 'a.ts' },
    });

    expect(response).toEqual({ id: '1', type: 'api:git/stage', success: true, data: { success: true } });
    expect(gitService.stageGitFiles).toHaveBeenCalledWith('/repo', ['a.ts']);
  });

  it('accepts bulk stage paths payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/stage',
      payload: { directory: '/repo', paths: ['a.ts', 'b.ts'] },
    });

    expect(response?.success).toBe(true);
    expect(gitService.stageGitFiles).toHaveBeenCalledWith('/repo', ['a.ts', 'b.ts']);
  });

  it('accepts legacy unstage path payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/unstage',
      payload: { directory: '/repo', path: 'a.ts' },
    });

    expect(response).toEqual({ id: '1', type: 'api:git/unstage', success: true, data: { success: true } });
    expect(gitService.unstageGitFiles).toHaveBeenCalledWith('/repo', ['a.ts']);
  });

  it('accepts bulk unstage paths payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/unstage',
      payload: { directory: '/repo', paths: ['a.ts', 'b.ts'] },
    });

    expect(response?.success).toBe(true);
    expect(gitService.unstageGitFiles).toHaveBeenCalledWith('/repo', ['a.ts', 'b.ts']);
  });

  it('rejects invalid path payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/stage',
      payload: { directory: '/repo', paths: [' ', null] },
    });

    expect(response?.success).toBe(false);
    expect(gitService.stageGitFiles).not.toHaveBeenCalled();
  });

  it('rejects invalid commit hashes before commit actions reach git service', async () => {
    const checkoutResponse = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/checkout-commit',
      payload: { directory: '/repo', hash: 'HEAD' },
    });
    const cherryPickResponse = await handleStandardGitBridgeMessage({
      id: '2',
      type: 'api:git/cherry-pick',
      payload: { directory: '/repo', hash: '--abort' },
    });
    const revertResponse = await handleStandardGitBridgeMessage({
      id: '3',
      type: 'api:git/revert-commit',
      payload: { directory: '/repo', hash: '--continue' },
    });
    const resetResponse = await handleStandardGitBridgeMessage({
      id: '4',
      type: 'api:git/reset-to-commit',
      payload: { directory: '/repo', hash: '--hard', mode: 'mixed' },
    });

    expect(checkoutResponse).toEqual({ id: '1', type: 'api:git/checkout-commit', success: false, error: 'Invalid commit hash' });
    expect(cherryPickResponse).toEqual({ id: '2', type: 'api:git/cherry-pick', success: false, error: 'Invalid commit hash' });
    expect(revertResponse).toEqual({ id: '3', type: 'api:git/revert-commit', success: false, error: 'Invalid commit hash' });
    expect(resetResponse).toEqual({ id: '4', type: 'api:git/reset-to-commit', success: false, error: 'Invalid commit hash' });
    expect(gitService.checkoutCommit).not.toHaveBeenCalled();
    expect(gitService.cherryPick).not.toHaveBeenCalled();
    expect(gitService.revertCommit).not.toHaveBeenCalled();
    expect(gitService.resetToCommit).not.toHaveBeenCalled();
  });
});
