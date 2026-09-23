import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ locationGet: vi.fn(), list: vi.fn(), remove: vi.fn() }));
vi.mock('@/lib/opencode/client', () => ({ opencodeClient: { getApiClient: () => ({
  location: { get: sdk.locationGet }, permission: { saved: { list: sdk.list, remove: sdk.remove } },
}) } }));

import { deletePermissionSaved, listPermissionSaved, resolvePermissionSavedProject } from './permission-saved-api';

describe('saved permission official client boundary', () => {
  beforeEach(() => vi.resetAllMocks());

  it('resolves the upstream ID through the explicit directory and forwards cancellation', async () => {
    sdk.locationGet.mockResolvedValue({ project: { id: 'upstream-project' } });
    const signal = new AbortController().signal;
    expect(await resolvePermissionSavedProject('/workspace/project', signal)).toBe('upstream-project');
    expect(sdk.locationGet).toHaveBeenCalledWith({ location: { directory: '/workspace/project' } }, { signal });
  });

  it('forwards the authoritative project ID and signal to the saved list', async () => {
    const items = [{ id: 'saved', projectID: 'upstream', action: 'bash', resource: 'npm test' }];
    sdk.list.mockResolvedValue(items);
    const signal = new AbortController().signal;
    expect(await listPermissionSaved({ projectID: 'upstream', signal })).toEqual(items);
    expect(sdk.list).toHaveBeenCalledWith({ projectID: 'upstream' }, { signal });
    await deletePermissionSaved({ id: 'saved/a b', signal });
    expect(sdk.remove).toHaveBeenCalledWith({ id: 'saved/a b' }, { signal });
  });

  it('rejects missing identities, malformed lists and cross-project results', async () => {
    sdk.locationGet.mockResolvedValue({});
    await expect(resolvePermissionSavedProject('/repo')).rejects.toThrow('project ID');
    for (const payload of [null, {}, [null], [{ id: 'saved' }], [{ id: 'saved', projectID: 'other', action: 'bash', resource: '*' }]]) {
      sdk.list.mockResolvedValue(payload);
      await expect(listPermissionSaved({ projectID: 'upstream' })).rejects.toThrow();
    }
  });

  it('preserves failures and stops aborted results', async () => {
    sdk.list.mockRejectedValue(new Error('offline'));
    await expect(listPermissionSaved({ projectID: 'upstream' })).rejects.toThrow('offline');
    sdk.remove.mockRejectedValue(new Error('denied'));
    await expect(deletePermissionSaved({ id: 'saved' })).rejects.toThrow('denied');
    const controller = new AbortController();
    sdk.locationGet.mockImplementation(async () => {
      controller.abort();
      return { project: { id: 'upstream' } };
    });
    await expect(resolvePermissionSavedProject('/repo', controller.signal)).rejects.toThrow();
  });
});
