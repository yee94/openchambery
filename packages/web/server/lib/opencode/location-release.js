/**
 * Explicit worktree deletion only. An eviction acknowledgement detaches cached
 * services; it does not prove that borrowers have released every OS handle.
 * Never use this operation for automatic navigation cleanup on a shared serve.
 *
 * @param {{ getClient: () => import('@opencode/client').OpenCodeClient | null, directory: string, timeoutMs?: number }} input
 * @returns {Promise<{ state: 'released' | 'timeout' | 'failed' | 'unavailable' }>}
 */
export async function releaseDeletedWorktreeLocation({ getClient, directory, timeoutMs = 2000 }) {
  const controller = new AbortController();
  let timer;
  try {
    if (!directory || !directory.trim()) return { state: 'unavailable' };
    const client = getClient();
    if (!client) return { state: 'unavailable' };
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ state: 'timeout' });
      }, timeoutMs);
    });
    const request = Promise.resolve().then(() => client.debug.location.evict(
      { location: { directory } },
      { signal: controller.signal },
    )).then(() => ({ state: 'released' }), () => ({ state: controller.signal.aborted ? 'timeout' : 'failed' }));
    return await Promise.race([request, deadline]);
  } catch {
    return { state: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}
