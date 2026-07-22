import { useMemo, useSyncExternalStore } from 'react';
import type { MessageQueueScope } from '@/lib/message-queue-server';
import { getMessageQueueServerRuntime, type MessageQueueServerDisplayItem, type MessageQueueServerRuntimeCapture, type MessageQueueServerSurface } from './message-queue-server-runtime';
import { editServerQueueItemIntoDraft } from './message-queue-server-edit-bridge';
import { getMessageQueueCutover, type MessageQueueCutover } from './message-queue-cutover';
import { getQueueForScope, useMessageQueueStore, type QueueItem } from '@/stores/messageQueueStore';

export type MessageQueueServerScopeInput = { transportIdentity: string; directory: string; sessionID: string };
export type MessageQueueServerScopeView = {
  runtimeCapture: MessageQueueServerRuntimeCapture;
  capability: ReturnType<MessageQueueServerSurface['getState']>['capability'];
  authority: string | undefined;
  mode: 'legacy' | 'server' | 'frozen';
  importState: ReturnType<MessageQueueServerSurface['getState']>['importState'];
  hydration: ReturnType<MessageQueueServerSurface['getState']>['hydration'];
  scope: MessageQueueScope | undefined;
  items: readonly MessageQueueServerDisplayItem[];
  hasPendingAdmission: boolean;
  hasBlockingAdmission: boolean;
  actions: Pick<MessageQueueServerSurface, 'admit' | 'edit' | 'remove' | 'reorder' | 'manualSend' | 'refresh' | 'runShadowImport' | 'captureRuntime'> & { editIntoDraft: typeof editServerQueueItemIntoDraft };
};

const EMPTY_ITEMS: readonly MessageQueueServerDisplayItem[] = [];

export const useMessageQueueServerScope = (input: MessageQueueServerScopeInput, runtime: MessageQueueServerSurface = getMessageQueueServerRuntime(), cutover: MessageQueueCutover = getMessageQueueCutover()): MessageQueueServerScopeView => {
  const scopeInput = useMemo(() => ({ transportIdentity: input.transportIdentity, directory: input.directory, sessionID: input.sessionID }), [input.directory, input.sessionID, input.transportIdentity]);
  const localSelector = useMemo(() => (state: ReturnType<typeof useMessageQueueStore.getState>) => getQueueForScope(state, { state: 'bound' as const, ...scopeInput }), [scopeInput]);
  const localItems = useMessageQueueStore(localSelector);
  const source = useMemo(() => {
    let previous: MessageQueueServerScopeView | undefined;
    let previousPending: ReturnType<MessageQueueServerSurface['getPendingAdmissions']> | undefined;
    let previousLocalItems: readonly QueueItem[] | undefined;
    const actions = { admit: runtime.admit, edit: runtime.edit, remove: runtime.remove, reorder: runtime.reorder, manualSend: runtime.manualSend, refresh: runtime.refresh, runShadowImport: runtime.runShadowImport, captureRuntime: runtime.captureRuntime, editIntoDraft: editServerQueueItemIntoDraft };
    const getSnapshot = (): MessageQueueServerScopeView => {
      const state = runtime.getState(), runtimeCapture = runtime.captureRuntime(), scope = runtime.getScope(scopeInput), pending = runtime.getPendingAdmissions(scopeInput), cutoverState = cutover.getSnapshot();
      const stableRuntimeCapture = previous?.runtimeCapture.transportIdentity === runtimeCapture.transportIdentity && previous.runtimeCapture.generation === runtimeCapture.generation ? previous.runtimeCapture : runtimeCapture;
      const mode = cutoverState.ownership === 'legacy-unsupported' ? 'legacy' : cutoverState.ownership === 'server-active' || cutoverState.ownership === 'server-paused' ? 'server' : 'frozen';
      const hasPendingAdmission = mode === 'server' && pending.length > 0;
      const hasBlockingAdmission = mode === 'server' && pending.some((entry) => entry.phase === 'uploading' || entry.phase === 'admitting' || entry.phase === 'ambiguous');
      const items = previous?.mode === mode && previous.scope === scope && previous.hasPendingAdmission === hasPendingAdmission && previous.hasBlockingAdmission === hasBlockingAdmission && pending === previousPending && localItems === previousLocalItems
        ? previous.items
        : mode === 'server'
          ? pending.length ? [...(scope?.items ?? EMPTY_ITEMS), ...pending.filter((entry) => !scope?.items.some((item) => item.queueItemID === entry.queueItemID))] : scope?.items ?? pending
          : mode === 'frozen' ? localItems as unknown as readonly MessageQueueServerDisplayItem[] : EMPTY_ITEMS;
      if (previous?.runtimeCapture === stableRuntimeCapture && previous.capability === state.capability && previous.authority === state.authority && previous.mode === mode && previous.importState === state.importState && previous.hydration === state.hydration && previous.scope === scope && previous.items === items && previous.hasPendingAdmission === hasPendingAdmission && previous.hasBlockingAdmission === hasBlockingAdmission) return previous;
      previousPending = pending; previousLocalItems = localItems;
      previous = { runtimeCapture: stableRuntimeCapture, capability: state.capability, authority: state.authority, mode, importState: state.importState, hydration: state.hydration, scope, items, hasPendingAdmission, hasBlockingAdmission, actions };
      return previous;
    };
    return { subscribe: (listener: () => void) => { const unsubRuntime = runtime.subscribeScope(scopeInput, listener), unsubCutover = cutover.subscribe(listener); return () => { unsubRuntime(); unsubCutover(); }; }, getSnapshot };
  }, [cutover, localItems, runtime, scopeInput]);
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
};
