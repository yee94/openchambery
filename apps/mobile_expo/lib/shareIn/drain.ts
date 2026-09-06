export type ShareDrainItem = {
  operationID: string;
  cleanupPhase?: 'server-completed' | 'native-acked' | 'files-released';
};

export const retryShareCleanupStage = async (
  work: () => Promise<void>,
  attempts = 3,
): Promise<void> => {
  let error: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await work();
      return;
    } catch (caught) {
      error = caught;
    }
  }
  throw error;
};

/** Fair queue drain — Cap mobileShareDrain. Failed ops yield; others continue. */
export const drainShareItems = async (
  items: ShareDrainItem[],
  handlers: {
    deliver: (operationID: string) => Promise<void>;
    cleanup: (operationID: string) => Promise<void>;
  },
  concurrency = 1,
): Promise<void> => {
  const queue = [...new Map(items.map((item) => [item.operationID, item])).values()];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < queue.length) {
      const item = queue[cursor++]!;
      try {
        if (item.cleanupPhase && item.cleanupPhase !== 'files-released') {
          await handlers.cleanup(item.operationID);
        } else {
          await handlers.deliver(item.operationID);
        }
      } catch {
        // Retain durable phase; continue fair queue.
      }
    }
  };
  const workers = Math.min(Math.max(1, concurrency), Math.max(1, queue.length));
  if (queue.length === 0) return;
  await Promise.all(Array.from({ length: workers }, () => worker()));
};
