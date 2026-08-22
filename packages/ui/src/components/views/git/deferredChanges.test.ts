import { afterEach, describe, expect, test } from 'vitest';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { GitStatus, RuntimeAPIs } from '@/lib/api/types';
import { isDeferredGitChangesStatus } from './deferredChanges';

const createStatus = (overrides: Partial<GitStatus> = {}): GitStatus => ({
  current: 'main',
  tracking: null,
  ahead: 0,
  behind: 0,
  files: [{ path: 'file.ts', index: ' ', working_dir: 'M' }],
  isClean: false,
  ...overrides,
});

const createHugeFiles = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    path: `file-${index}.ts`,
    index: ' ',
    working_dir: 'M',
  }));

const installVSCodeRuntime = () => {
  registerRuntimeAPIs({ runtime: { isVSCode: true } } as unknown as RuntimeAPIs);
};

afterEach(() => {
  registerRuntimeAPIs(null);
});

describe('isDeferredGitChangesStatus', () => {
  test('defers only when the server marks the status oversized', () => {
    expect(isDeferredGitChangesStatus(createStatus({ oversized: true }))).toBe(true);
  });

  test('does not defer when the server omits the flag', () => {
    expect(isDeferredGitChangesStatus(createStatus())).toBe(false);
    expect(isDeferredGitChangesStatus(createStatus({ oversized: false }))).toBe(false);
    expect(isDeferredGitChangesStatus(createStatus({ oversized: undefined }))).toBe(false);
  });

  test('null/undefined status never defers', () => {
    expect(isDeferredGitChangesStatus(null)).toBe(false);
    expect(isDeferredGitChangesStatus(undefined)).toBe(false);
  });

  test('client never applies its own file-count threshold against server declarations', () => {
    // The server owns the threshold; a huge files array with an explicit
    // server declaration must NOT defer (the client no longer second-guesses
    // the server when the flag is present).
    const hugeButNotMarked = createStatus({
      oversized: false,
      files: createHugeFiles(100_000),
    });
    expect(isDeferredGitChangesStatus(hugeButNotMarked)).toBe(false);

    const hugeAndMarked = createStatus({
      oversized: true,
      files: createHugeFiles(100_000),
    });
    expect(isDeferredGitChangesStatus(hugeAndMarked)).toBe(true);
  });

  test('legacy Host fallback defers huge unflagged change sets on web runtimes', () => {
    // Old Hosts never send `oversized`; a very large change set still needs
    // render-side deferral as the last line of defense.
    expect(isDeferredGitChangesStatus(createStatus({ files: createHugeFiles(5001) }))).toBe(true);
    // Below the legacy threshold stays direct rendering.
    expect(isDeferredGitChangesStatus(createStatus({ files: createHugeFiles(5000) }))).toBe(false);
    expect(isDeferredGitChangesStatus(createStatus({ files: createHugeFiles(2001) }))).toBe(false);
  });

  test('legacy Host fallback never activates on the VS Code runtime', () => {
    // VS Code computes git status locally without diffStats; there is no heavy
    // path to degrade, so deferred rendering must stay off there.
    installVSCodeRuntime();
    expect(isDeferredGitChangesStatus(createStatus({ files: createHugeFiles(100_000) }))).toBe(false);
    // An explicit server-style flag still wins on any runtime.
    expect(isDeferredGitChangesStatus(createStatus({ oversized: true }))).toBe(true);
  });
});
