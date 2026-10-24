import { afterEach, expect, test, vi } from 'vitest';

const { git } = vi.hoisted(() => ({ git: {
  raw: vi.fn(), branch: vi.fn(), getRemotes: vi.fn(),
} }));
vi.mock('simple-git', () => ({ default: () => git }));
import { getBranches } from './service.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

test('branch listing never contacts remotes and keeps locally known refs while offline', async () => {
  vi.stubEnv('SSH_AUTH_SOCK', '/test/ssh-agent');
  git.raw.mockImplementation(async (args) => {
    if (args.join(' ') === 'rev-parse --show-toplevel') return '/repo\n';
    throw new Error('Unexpected remote command');
  });
  git.getRemotes.mockRejectedValue(new Error('offline'));
  const branches = {
    all: ['main', 'feature/local', 'remotes/origin/main', 'remotes/origin/feature/remote', 'remotes/origin/HEAD'],
    current: 'main',
    branches: { main: { current: true, name: 'main', commit: 'abc', label: 'main' } },
  };
  git.branch.mockResolvedValue(branches);
  expect(await getBranches('/repo')).toEqual({
    ...branches, all: branches.all.filter((name) => name !== 'remotes/origin/HEAD'),
  });
  expect(git.getRemotes).not.toHaveBeenCalled();
  expect(git.raw.mock.calls).toEqual([[['rev-parse', '--show-toplevel']]]);
  git.branch.mockResolvedValue({ ...branches, all: ['main', 'remotes/origin/new'] });
  expect((await getBranches('/repo')).all).toEqual(['main', 'remotes/origin/new']);
});

test('branch failures remain errors instead of an authoritative empty list', async () => {
  vi.stubEnv('SSH_AUTH_SOCK', '/test/ssh-agent');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  git.raw.mockResolvedValue('/repo\n');
  git.branch.mockRejectedValue(new Error('repository unavailable'));
  await expect(getBranches('/repo')).rejects.toThrow('repository unavailable');
});
