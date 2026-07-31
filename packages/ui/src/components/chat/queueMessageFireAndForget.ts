/**
 * Fire-and-forget queue admission entry.
 * Internal paths keep their own toasts; `onLeakedRejection` fires only when a
 * rejection escapes that work (e.g. restoreQueueComposer after an inner catch),
 * so callers never leave an unhandledRejection on the queue path.
 * Returns a settled promise for tests; event callers should void it.
 */
export const runQueueMessageFireAndForget = (
    run: () => PromiseLike<void>,
    onLeakedRejection: () => void,
): Promise<void> => (
    Promise.resolve()
        .then(() => run())
        .catch(() => {
            onLeakedRejection();
        })
);
