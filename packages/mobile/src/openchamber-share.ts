import { registerPlugin } from '@capacitor/core';

export type NativeAssistantCatalogEntry = {
  serverInstanceID: string;
  assistantID: string;
  name: string;
  avatarSeed: string;
  serverLabel: string;
  connectionKey: string;
  enabled: boolean;
  isDefaultShareTarget: boolean;
};

export type NativeShareAttachment = {
  stagedPath: string;
  originalName: string;
  mime: string;
  byteSize: number;
};

export type NativeShareEnvelope = {
  version: 1;
  operationID: string;
  serverInstanceID: string;
  assistantID: string;
  text?: string;
  attachments: NativeShareAttachment[];
  source: 'ios-share' | 'android-share';
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
};

export type NativeShareDraft = {
  version: 1;
  draftID: string;
  serverInstanceID: string;
  assistantID: string;
  name: string;
  avatarSeed: string;
  serverLabel: string;
  connectionKey: string;
  text?: string;
  attachments: NativeShareAttachment[];
  source: 'android-share';
  createdAt: number;
  expiresAt: number;
};

export interface OpenChamberSharePlugin {
  updateCatalog(options: { entries: NativeAssistantCatalogEntry[] }): Promise<void>;
  donateAssistantInteraction(options: { serverInstanceID: string; assistantID: string; name: string; avatarSeed: string }): Promise<void>;
  listPending(): Promise<{ envelopes: NativeShareEnvelope[] }>;
  ack(options: { operationID: string }): Promise<void>;
  releaseFiles(options: { operationID: string }): Promise<void>;
  listDrafts(): Promise<{ drafts: NativeShareDraft[] }>;
  cancelDraft(options: { draftID: string }): Promise<void>;
  addListener(eventName: 'shareReceived', listenerFunc: (event: { operationID: string }) => void): Promise<{ remove: () => Promise<void> }>;
  addListener(eventName: 'shareDraftReceived', listenerFunc: (event: { draftID: string }) => void): Promise<{ remove: () => Promise<void> }>;
}

export const OpenChamberShare = registerPlugin<OpenChamberSharePlugin>('OpenChamberShare');
