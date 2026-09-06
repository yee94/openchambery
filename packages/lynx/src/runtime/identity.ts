import type { LynxChosenTransport, LynxRuntimeIdentity } from '../connection/types';

export type RuntimeIdentityListener = (identity: LynxRuntimeIdentity | null) => void;

export const createRuntimeIdentityStore = () => {
  let current: LynxRuntimeIdentity | null = null;
  const listeners = new Set<RuntimeIdentityListener>();

  const notify = () => {
    for (const listener of listeners) listener(current);
  };

  return {
    get: (): LynxRuntimeIdentity | null => current,
    set: (identity: LynxRuntimeIdentity): void => {
      current = identity;
      notify();
    },
    switchToTransport: (transport: LynxChosenTransport, clientToken: string | null, runtimeKey: string): LynxRuntimeIdentity => {
      current = { runtimeKey, clientToken, transport };
      notify();
      return current;
    },
    clear: (): void => {
      current = null;
      notify();
    },
    subscribe: (listener: RuntimeIdentityListener): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

export type LynxRuntimeIdentityStore = ReturnType<typeof createRuntimeIdentityStore>;
