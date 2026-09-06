import { NativeModule, requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export const OPENCHAMBER_APP_GROUP = 'group.com.yee94.openchamber';

export type LiveActivityItem = {
  sessionId: string;
  title: string;
  status: string;
  startedAt: number;
  endedAt?: number;
};

export type LiveActivityRequest = {
  sessionId: string;
  startedAt?: number;
  status: string;
  eventVersion: number;
  updatedAt: number;
  endedAt?: number;
  dismissalSeconds?: number;
  title?: string;
  workingCount?: number;
  items?: LiveActivityItem[];
};

export type ShareCatalogEntry = {
  serverInstanceID: string;
  assistantID: string;
  name: string;
  avatarSeed: string;
  avatarEmoji?: string;
  serverLabel: string;
  connectionKey: string;
  enabled: boolean;
  isDefaultShareTarget: boolean;
};

export type ShareEnvelope = {
  version: 1;
  operationID: string;
  serverInstanceID: string;
  assistantID: string;
  text?: string;
  attachments: {
    stagedPath: string;
    originalName: string;
    mime: string;
    byteSize: number;
  }[];
  source: 'ios-share' | 'android-share';
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
};

export type ShareDraft = {
  version: 1;
  draftID: string;
  serverInstanceID?: string;
  assistantID?: string;
  name?: string;
  avatarSeed?: string;
  serverLabel?: string;
  connectionKey?: string;
  text?: string;
  attachments: {
    stagedPath: string;
    originalName: string;
    mime: string;
    byteSize: number;
  }[];
  source: 'android-share';
  createdAt: number;
  expiresAt: number;
};

type SystemShellNativeModule = NativeModule & {
  isLiveActivitySupported(): Promise<{ supported: boolean }>;
  startLiveActivity(request: LiveActivityRequest): Promise<{ activityId?: string }>;
  updateLiveActivity(request: LiveActivityRequest): Promise<void>;
  endLiveActivity(request: LiveActivityRequest): Promise<void>;
  updateShareCatalog(entries: ShareCatalogEntry[]): Promise<void>;
  listPendingShares(): Promise<{ envelopes: ShareEnvelope[] }>;
  ackShare(operationID: string): Promise<void>;
  releaseShareFiles(operationID: string): Promise<void>;
  listShareDrafts(): Promise<{ drafts: ShareDraft[] }>;
  cancelShareDraft(draftID: string): Promise<void>;
  createVirtualAsset(assetId: string, mime: string): Promise<{ assetId: string; url: string }>;
  appendVirtualAsset(assetId: string, chunkBase64: string): Promise<void>;
  finishVirtualAsset(assetId: string): Promise<{ url: string }>;
  cancelVirtualAsset(assetId: string): Promise<void>;
  getCapabilities(): Promise<{
    platform: string;
    liveActivity: boolean;
    shareAppGroup: boolean;
    uiGlassEffect: boolean;
    uiTabBar: boolean;
    nativeComposerTextView?: boolean;
  }>;
};

let native: SystemShellNativeModule | null = null;

const getNative = (): SystemShellNativeModule | null => {
  if (native) return native;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    native = requireNativeModule<SystemShellNativeModule>('OpenChamberSystemShell');
    return native;
  } catch {
    return null;
  }
};

export const getSystemShellCapabilities = async () => {
  const mod = getNative();
  if (!mod) {
    return {
      platform: Platform.OS,
      liveActivity: false,
      shareAppGroup: false,
      uiGlassEffect: false,
      uiTabBar: false,
      nativeComposerTextView: false,
      nativeModuleLoaded: false,
    };
  }
  const caps = await mod.getCapabilities();
  return { ...caps, nativeModuleLoaded: true };
};

export const liveActivityNative = {
  async isSupported(): Promise<boolean> {
    if (Platform.OS !== 'ios') return false;
    const mod = getNative();
    if (!mod) return false;
    const result = await mod.isLiveActivitySupported();
    return !!result.supported;
  },
  async start(request: LiveActivityRequest) {
    if (Platform.OS !== 'ios') return {};
    return (await getNative()?.startLiveActivity(request)) ?? {};
  },
  async update(request: LiveActivityRequest) {
    if (Platform.OS !== 'ios') return;
    await getNative()?.updateLiveActivity(request);
  },
  async end(request: LiveActivityRequest) {
    if (Platform.OS !== 'ios') return;
    await getNative()?.endLiveActivity(request);
  },
};

export const shareNative = {
  async updateCatalog(entries: ShareCatalogEntry[]) {
    await getNative()?.updateShareCatalog(entries);
  },
  async listPending(): Promise<ShareEnvelope[]> {
    const result = await getNative()?.listPendingShares();
    return result?.envelopes ?? [];
  },
  async ack(operationID: string) {
    await getNative()?.ackShare(operationID);
  },
  async releaseFiles(operationID: string) {
    await getNative()?.releaseShareFiles(operationID);
  },
  async listDrafts(): Promise<ShareDraft[]> {
    const result = await getNative()?.listShareDrafts?.();
    return result?.drafts ?? [];
  },
  async cancelDraft(draftID: string) {
    await getNative()?.cancelShareDraft?.(draftID);
  },
};

export const virtualAssetNative = {
  async create(assetId: string, mime: string) {
    const mod = getNative();
    if (!mod) throw new Error('virtual_asset_unavailable');
    return mod.createVirtualAsset(assetId, mime);
  },
  async append(assetId: string, chunkBase64: string) {
    const mod = getNative();
    if (!mod) throw new Error('virtual_asset_unavailable');
    return mod.appendVirtualAsset(assetId, chunkBase64);
  },
  async finish(assetId: string) {
    const mod = getNative();
    if (!mod) throw new Error('virtual_asset_unavailable');
    return mod.finishVirtualAsset(assetId);
  },
  async cancel(assetId: string) {
    const mod = getNative();
    if (!mod) throw new Error('virtual_asset_unavailable');
    return mod.cancelVirtualAsset(assetId);
  },
};

export { NativeComposerTextView } from './NativeComposerTextView';
export type {
  NativeComposerChangeTextEvent,
  NativeComposerCollapsedHeightEvent,
  NativeComposerContentSizeEvent,
  NativeComposerSelectionEvent,
  NativeComposerSubmitEvent,
  NativeComposerTextViewProps,
} from './NativeComposerTextView.types';
