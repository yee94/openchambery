import React from 'react';
import type { Message, Part } from '@opencode-ai/sdk/v2';

type MessageRecord = { info: Message; parts: Part[] };

type SyncHarnessFrame = {
  messages: MessageRecord[];
  status: { type: 'idle' | 'busy' | 'retry' } | null;
  renderable: boolean;
  p0Satisfied: boolean;
  prefetchStatus: 'loading' | 'ready' | 'error';
  syncLoading: boolean;
};

let frame: SyncHarnessFrame = {
  messages: [],
  status: { type: 'idle' },
  renderable: false,
  p0Satisfied: false,
  prefetchStatus: 'loading',
  syncLoading: true,
};
const listeners = new Set<() => void>();

export const setDraftHandoffSyncFrame = (next: Partial<SyncHarnessFrame>) => {
  frame = { ...frame, ...next };
  for (const listener of listeners) listener();
};

export const readDraftHandoffSyncFrame = () => frame;

const useFrame = () => React.useSyncExternalStore(
  (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  () => frame,
  () => frame,
);

export const useSyncDirectory = () => '/fixture/project';
export const useSessionDirectory = () => '/fixture/project';
export const useSessionMessageCount = () => useFrame().messages.length;
export const useSessionMessageRecords = () => useFrame().messages;
export const useSessionMessages = () => useFrame().messages.map((entry) => entry.info);
export const useSessionMessageLoadState = () => ({ status: useFrame().prefetchStatus });
export const useSessionMaterializationStatus = () => ({ renderable: useFrame().renderable });
export const useSessionTranscriptHydration = () => ({ p0Satisfied: useFrame().p0Satisfied });
export const useSessionTranscriptPagination = () => ({
  boundary: { kind: 'complete' as const, loadedTurns: useFrame().messages.filter((entry) => entry.info.role === 'user').length },
});
export const useSessionStatus = () => useFrame().status;
export const useSessionStatusObservedAt = () => 10_000;
export const useSessionStatusSnapshotAt = () => 10_000;
export const useSessionParts = (messageID: string) => (
  useFrame().messages.find((entry) => entry.info.id === messageID)?.parts ?? []
);
export const useSessionPermissions = () => [];
export const useSessionQuestions = () => [];
export const useScopedBlockingPermissions = () => [];
export const useScopedBlockingQuestions = () => [];
export const useSessions = () => [];
export const useParentSessionTarget = () => null;
export const useDirectorySync = <T,>(selector: (state: { todo: Record<string, never[]> }) => T) => selector({ todo: {} });
export const useEnsureSessionMessages = () => async () => undefined;
export const useChildStoreManager = () => ({ getChild: () => null, ensureChild: () => null });
export const useScopedSessionStatusReader = () => () => frame.status;
export const useScopedSessionStatusRevision = () => 0;
export const useSession = (sessionID?: string | null) => (
  sessionID ? { id: sessionID, directory: '/fixture/project', title: 'Fixture session' } : null
);
export const useCurrentSessionEntity = (sessionID?: string | null) => (
  sessionID ? { id: sessionID, directory: '/fixture/project', title: 'Fixture session' } : null
);
export const setActiveSession = () => undefined;
export const resyncBlockingRequestsForDirectory = async () => undefined;
