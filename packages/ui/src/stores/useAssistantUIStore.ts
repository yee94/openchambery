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
  settingsSelectedAssistantID: string | 'new' | null;
  defaultShareAssistant: { serverInstanceID: string; assistantID: string } | null;
  assistantCatalogByConnection: Record<string, AssistantCatalogPartition>;
  createRequestRevision: number;
  selectAssistant: (assistantID: string | null) => void;
  selectSettingsAssistant: (assistantID: string | 'new' | null) => void;
  setDefaultShareAssistant: (target: { serverInstanceID: string; assistantID: string } | null) => void;
  replaceCatalogPartition: (partition: AssistantCatalogPartition) => void;
  removeCatalogPartition: (connectionKey: string) => void;
  requestCreate: () => void;
};

const transport = () => getRuntimeTransportIdentity();
const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const parseCatalogEntry = (value: unknown): AssistantCatalogEntry | null => {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if (!nonEmptyString(entry.serverInstanceID) || !nonEmptyString(entry.assistantID) || !nonEmptyString(entry.name) || !nonEmptyString(entry.avatarSeed) || !nonEmptyString(entry.serverLabel) || !nonEmptyString(entry.connectionKey) || typeof entry.enabled !== 'boolean') return null;
  return { serverInstanceID: entry.serverInstanceID, assistantID: entry.assistantID, name: entry.name, avatarSeed: entry.avatarSeed, serverLabel: entry.serverLabel, connectionKey: entry.connectionKey, enabled: entry.enabled, isDefaultShareTarget: false };
};
const parseCatalogPartitions = (value: unknown): Record<string, AssistantCatalogPartition> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, candidate]): [string, AssistantCatalogPartition][] => {
    if (!candidate || typeof candidate !== 'object') return [];
    const partition = candidate as Record<string, unknown>;
    if (!nonEmptyString(partition.serverInstanceID) || !nonEmptyString(partition.connectionKey) || partition.connectionKey !== key || typeof partition.revision !== 'number' || !Number.isFinite(partition.revision) || typeof partition.lastLoadedAt !== 'number' || !Number.isFinite(partition.lastLoadedAt) || !Array.isArray(partition.entries)) return [];
    const entries = partition.entries.map(parseCatalogEntry);
    if (entries.some((entry) => entry === null) || entries.some((entry) => entry?.connectionKey !== key || entry.serverInstanceID !== partition.serverInstanceID)) return [];
    return [[key, { serverInstanceID: partition.serverInstanceID, connectionKey: partition.connectionKey, revision: partition.revision, lastLoadedAt: partition.lastLoadedAt, entries: entries as AssistantCatalogEntry[] }]];
  }));
};

export const useAssistantUIStore = create<AssistantUIState>()(persist((set) => ({
  assistantByTransport: {},
  settingsSelectedAssistantID: null,
  defaultShareAssistant: null,
  assistantCatalogByConnection: {},
  createRequestRevision: 0,
  selectAssistant: (assistantID) => set((state) => ({
    assistantByTransport: { ...state.assistantByTransport, [transport()]: assistantID },
  })),
  selectSettingsAssistant: (assistantID) => set({ settingsSelectedAssistantID: assistantID }),
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
    const target = state.defaultShareAssistant;
    const assistantCatalogByConnection = { ...state.assistantCatalogByConnection };
    delete assistantCatalogByConnection[connectionKey];
    const defaultStillExists = Boolean(target && Object.values(assistantCatalogByConnection).some((candidate) => candidate.serverInstanceID === target.serverInstanceID && candidate.entries.some((entry) => entry.assistantID === target.assistantID)));
    return { assistantCatalogByConnection, ...(target && !defaultStillExists ? { defaultShareAssistant: null } : {}) };
  }),
  requestCreate: () => set((state) => ({ createRequestRevision: state.createRequestRevision + 1, settingsSelectedAssistantID: 'new' })),
}), {
  name: 'openchamber-assistant-ui',
  storage: createDeferredSafeJSONStorage(),
  partialize: (state) => ({ assistantByTransport: state.assistantByTransport, defaultShareAssistant: state.defaultShareAssistant, assistantCatalogByConnection: state.assistantCatalogByConnection }),
  migrate: (persisted) => {
    const value = persisted && typeof persisted === 'object' ? persisted as Record<string, unknown> : {};
    const assistantByTransport = value.assistantByTransport && typeof value.assistantByTransport === 'object' && !Array.isArray(value.assistantByTransport)
      ? Object.fromEntries(Object.entries(value.assistantByTransport as Record<string, unknown>).flatMap(([key, assistantID]): [string, string | null][] => nonEmptyString(key) && (assistantID === null || nonEmptyString(assistantID)) ? [[key, assistantID]] : []))
      : {};
    const target = value.defaultShareAssistant;
    const defaultShareAssistant: { serverInstanceID: string; assistantID: string } | null = target && typeof target === 'object'
      && nonEmptyString((target as Record<string, unknown>).serverInstanceID)
      && nonEmptyString((target as Record<string, unknown>).assistantID)
      ? { serverInstanceID: (target as Record<string, unknown>).serverInstanceID as string, assistantID: (target as Record<string, unknown>).assistantID as string }
      : null;
    const assistantCatalogByConnection = parseCatalogPartitions(value.assistantCatalogByConnection);
    const validDefault = defaultShareAssistant && Object.values(assistantCatalogByConnection).some((partition) => partition.serverInstanceID === defaultShareAssistant.serverInstanceID && partition.entries.some((entry) => entry.assistantID === defaultShareAssistant.assistantID));
    return { assistantByTransport, assistantCatalogByConnection, defaultShareAssistant: validDefault ? defaultShareAssistant : null };
  },
  version: 4,
}));

export const getSelectedAssistantID = (): string | null => useAssistantUIStore.getState().assistantByTransport[transport()] ?? null;
export const getDefaultShareAssistant = (): { serverInstanceID: string; assistantID: string } | null => useAssistantUIStore.getState().defaultShareAssistant;
export const setDefaultShareAssistantID = (assistantID: string | null, serverInstanceID?: string): void => useAssistantUIStore.getState().setDefaultShareAssistant(assistantID && serverInstanceID ? { assistantID, serverInstanceID } : null);

export const openAssistant = (assistantID?: string | null): void => {
  const state = useAssistantUIStore.getState();
  if (assistantID !== undefined) state.selectAssistant(assistantID);
  useUIStore.getState().setActiveMainTab('assistant');
};
