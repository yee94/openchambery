import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { useUIStore } from './useUIStore';

export type AssistantCatalogEntry = {
  serverInstanceID: string;
  assistantID: string;
  name: string;
  avatarSeed: string;
  serverLabel: string;
  connectionKey: string;
  enabled: boolean;
  isDefaultShareTarget: boolean;
};

export type AssistantCatalogPartition = {
  serverInstanceID: string;
  connectionKey: string;
  revision: number;
  lastLoadedAt: number;
  entries: AssistantCatalogEntry[];
};

type AssistantUIState = {
  assistantByTransport: Record<string, string | null>;
  topicByTransport: Record<string, string | null>;
  defaultShareAssistant: { serverInstanceID: string; assistantID: string } | null;
  assistantCatalogByConnection: Record<string, AssistantCatalogPartition>;
  selectAssistant: (assistantID: string | null) => void;
  selectTopic: (topicID: string | null) => void;
  setDefaultShareAssistant: (target: { serverInstanceID: string; assistantID: string } | null) => void;
  replaceCatalogPartition: (partition: AssistantCatalogPartition) => void;
  removeCatalogPartition: (connectionKey: string) => void;
};

const transport = () => getRuntimeTransportIdentity();

export const useAssistantUIStore = create<AssistantUIState>()(persist((set) => ({
  assistantByTransport: {},
  topicByTransport: {},
  defaultShareAssistant: null,
  assistantCatalogByConnection: {},
  selectAssistant: (assistantID) => set((state) => ({
    assistantByTransport: { ...state.assistantByTransport, [transport()]: assistantID },
    topicByTransport: { ...state.topicByTransport, [transport()]: null },
  })),
  selectTopic: (topicID) => set((state) => ({
    topicByTransport: { ...state.topicByTransport, [transport()]: topicID },
  })),
  setDefaultShareAssistant: (target) => set((state) => ({
    defaultShareAssistant: target,
    assistantCatalogByConnection: Object.fromEntries(Object.entries(state.assistantCatalogByConnection).map(([key, partition]) => [key, {
      ...partition,
      entries: partition.entries.map((entry) => ({ ...entry, isDefaultShareTarget: Boolean(target && entry.serverInstanceID === target.serverInstanceID && entry.assistantID === target.assistantID) })),
    }])),
  })),
  replaceCatalogPartition: (partition) => set((state) => {
    const target = state.defaultShareAssistant;
    return { assistantCatalogByConnection: { ...state.assistantCatalogByConnection, [partition.connectionKey]: {
      ...partition,
      entries: partition.entries.map((entry) => ({ ...entry, isDefaultShareTarget: Boolean(target && entry.serverInstanceID === target.serverInstanceID && entry.assistantID === target.assistantID) })),
    } } };
  }),
  removeCatalogPartition: (connectionKey) => set((state) => {
    const partition = state.assistantCatalogByConnection[connectionKey];
    const target = state.defaultShareAssistant;
    const assistantCatalogByConnection = { ...state.assistantCatalogByConnection };
    delete assistantCatalogByConnection[connectionKey];
    const defaultStillExists = Boolean(target && Object.values(assistantCatalogByConnection).some((candidate) => candidate.serverInstanceID === target.serverInstanceID && candidate.entries.some((entry) => entry.assistantID === target.assistantID)));
    return { assistantCatalogByConnection, ...(target && !defaultStillExists ? { defaultShareAssistant: null } : {}) };
  }),
}), {
  name: 'openchamber-assistant-ui',
  storage: createDeferredSafeJSONStorage(),
  partialize: (state) => ({ defaultShareAssistant: state.defaultShareAssistant, assistantCatalogByConnection: state.assistantCatalogByConnection }),
  migrate: (persisted) => {
    const value = persisted && typeof persisted === 'object' ? persisted as Record<string, unknown> : {};
    const target = value.defaultShareAssistant;
    const defaultShareAssistant = target && typeof target === 'object'
      && typeof (target as Record<string, unknown>).serverInstanceID === 'string'
      && typeof (target as Record<string, unknown>).assistantID === 'string' ? target : null;
    return { ...value, defaultShareAssistant };
  },
  version: 3,
}));

export const getSelectedAssistantID = (): string | null => useAssistantUIStore.getState().assistantByTransport[transport()] ?? null;
export const getSelectedAssistantTopicID = (): string | null => useAssistantUIStore.getState().topicByTransport[transport()] ?? null;
export const getDefaultShareAssistant = (): { serverInstanceID: string; assistantID: string } | null => useAssistantUIStore.getState().defaultShareAssistant;
export const setDefaultShareAssistantID = (assistantID: string | null, serverInstanceID?: string): void => useAssistantUIStore.getState().setDefaultShareAssistant(assistantID && serverInstanceID ? { assistantID, serverInstanceID } : null);

export const openAssistant = (assistantID?: string | null, topicID?: string | null): void => {
  const state = useAssistantUIStore.getState();
  if (assistantID !== undefined) state.selectAssistant(assistantID);
  if (topicID !== undefined) state.selectTopic(topicID);
  useUIStore.getState().setActiveMainTab('assistant');
};
