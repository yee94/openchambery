export type MobileShareDrainItem = { operationID: string; cleanupPhase?: 'server-completed' | 'native-acked' | 'files-released' };

export const retryMobileShareCleanupStage = async (work: () => Promise<void>, attempts = 3): Promise<void> => {
  let error: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { await work(); return; } catch (caught) { error = caught; }
  }
  throw error;
};

export const drainMobileShareItems = async (
  items: MobileShareDrainItem[],
  handlers: { deliver: (operationID: string) => Promise<void>; cleanup: (operationID: string) => Promise<void> },
  concurrency = 2,
): Promise<void> => {
  const queue = [...new Map(items.map((item) => [item.operationID, item])).values()];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      try {
        if (item.cleanupPhase && item.cleanupPhase !== 'files-released') await handlers.cleanup(item.operationID);
        else await handlers.deliver(item.operationID);
      } catch {
        // Each operation retains its durable phase and yields to the next fair queue slot.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), queue.length) }, worker));
};
