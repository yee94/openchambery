import { expect, it, vi } from 'vitest';
import { workStatusChildrenQueryOptions } from './workStatusChildrenQuery';

it('lists child sessions by parent id and treats a missing payload as failure', async () => {
  const listChildren = vi.fn(async () => [{ id: 'child-1', title: '查同步层' }]);
  const options = workStatusChildrenQueryOptions('/repo', 'parent-1', {
    transport: 'runtime-a',
    listChildren,
  });
  expect(options.queryKey).toEqual(['runtime-a', 'workStatusChildren', '/repo', 'parent-1']);
  const signal = new AbortController().signal;
  await expect(options.queryFn?.({ signal } as never)).resolves.toEqual([{ id: 'child-1', title: '查同步层' }]);
  expect(listChildren).toHaveBeenCalledWith({ directory: '/repo', sessionID: 'parent-1', signal });

  const failing = workStatusChildrenQueryOptions('/repo', 'parent-1', {
    listChildren: async () => { throw new Error('session.list children returned no data'); },
  });
  await expect(failing.queryFn?.({ signal } as never)).rejects.toThrow('session.list children returned no data');
});
