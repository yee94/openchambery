import { Capacitor, registerPlugin } from '@capacitor/core';

import { isIPadApp } from '@/lib/platform';
import { getRuntimeGeneration, getRuntimeKey } from '@/lib/runtime-switch';
import { useMobileNavigationStore } from '@/mobile/useMobileNavigationStore';
import { fetchAssistantCapability, forceRefreshAssistantSnapshot } from '@/queries/assistantQueries';
import { openAssistant } from '@/stores/useAssistantUIStore';

import { connectMobileShareConnection } from './mobileConnections';

type NativeAssistantOpenRequest = {
  requestID: string;
  serverInstanceID: string;
  assistantID: string;
  connectionKey: string;
  createdAt: number;
  expiresAt: number;
};

type NativeAssistantShortcutPlugin = {
  pendingAssistantOpen(): Promise<{ request?: NativeAssistantOpenRequest | null }>;
  ackAssistantOpen(options: { requestID: string }): Promise<void>;
};

const OpenChamberShare = registerPlugin<NativeAssistantShortcutPlugin>('OpenChamberShare');
let nativeAssistantOpenFlight: Promise<boolean> | null = null;

const current = (connectionKey: string, generation: number): boolean =>
  getRuntimeKey() === connectionKey && getRuntimeGeneration() === generation;

export const openNativeAssistantConversation = (assistantID: string): void => {
  if (isIPadApp()) {
    openAssistant(assistantID);
    return;
  }
  const navigation = useMobileNavigationStore.getState();
  navigation.setActiveTab('assistant');
  navigation.openAssistant(assistantID);
};

const handlePendingNativeAssistantOpenOnce = async (): Promise<boolean> => {
  const pending = await OpenChamberShare.pendingAssistantOpen().catch(() => null);
  const request = pending?.request;
  if (!request) return false;
  const result = await connectMobileShareConnection(request.connectionKey);
  if (result === 'missing') {
    await OpenChamberShare.ackAssistantOpen({ requestID: request.requestID }).catch(() => undefined);
    return true;
  }
  if (result !== 'connected') return true;
  const generation = getRuntimeGeneration();
  if (!current(request.connectionKey, generation)) return true;
  try {
    const [capability, snapshot] = await Promise.all([
      fetchAssistantCapability(),
      forceRefreshAssistantSnapshot(),
    ]);
    if (!current(request.connectionKey, generation)) return true;
    const assistantExists = snapshot.assistants.some(
      (assistant) => assistant.id === request.assistantID && assistant.enabled,
    );
    if (
      !capability.supported
      || !capability.enabled
      || capability.serverInstanceID !== request.serverInstanceID
      || !assistantExists
    ) {
      await OpenChamberShare.ackAssistantOpen({ requestID: request.requestID });
      return true;
    }
    openNativeAssistantConversation(request.assistantID);
    await OpenChamberShare.ackAssistantOpen({ requestID: request.requestID });
  } catch {
    // Keep the native request durable for a later endpoint/resume retry.
  }
  return true;
};

export const handlePendingNativeAssistantOpen = async (): Promise<boolean> => {
  if (Capacitor.getPlatform() !== 'android') return false;
  if (nativeAssistantOpenFlight) return nativeAssistantOpenFlight;
  nativeAssistantOpenFlight = handlePendingNativeAssistantOpenOnce().finally(() => {
    nativeAssistantOpenFlight = null;
  });
  return nativeAssistantOpenFlight;
};
