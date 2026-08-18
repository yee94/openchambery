import React from 'react';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { usePwaManifestSync } from '@/hooks/usePwaManifestSync';
import { getQueuedMessageOwnershipGate, subscribeQueuedMessageOwnershipGate, useQueuedMessageAutoSend } from '@/hooks/useQueuedMessageAutoSend';
import { useSessionAutoCleanup } from '@/hooks/useSessionAutoCleanup';
import { useWindowControlsOverlayLayout } from '@/hooks/useWindowControlsOverlayLayout';
import { setOptimisticRefs } from '@/sync/session-actions';
import { markSessionViewed } from '@/sync/notification-store';
import { getMessageQueueServerRuntime, installMessageQueueServerRuntimeSwitch } from '@/sync/message-queue-server-runtime';
import { getMessageQueueCutover } from '@/sync/message-queue-cutover';
import { useQueueAbortOptimisticReconcile } from '@/sync/queue-abort-optimistic';
import { setExternallyViewedSession } from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { useWorktreeOrderSync } from '@/sync/worktree-order-sync';
import { restoreWebviewZoomFactor } from '@/lib/webviewZoom';
import { startWorktreeTopologySync } from '@/lib/worktrees/worktreeTopologySync';

const MINI_CHAT_PRESENCE_CHANNEL = 'openchamber:mini-chat-presence';

type MiniChatPresenceMessage = {
  type?: string;
  sessionId?: string;
  directory?: string;
  viewed?: boolean;
};

const SyncOptimisticBridge: React.FC = () => {
  const sync = useSync();
  const addRef = React.useRef(sync.optimistic.add);
  const removeRef = React.useRef(sync.optimistic.remove);
  const confirmRef = React.useRef(sync.optimistic.confirm);
  addRef.current = sync.optimistic.add;
  removeRef.current = sync.optimistic.remove;
  confirmRef.current = sync.optimistic.confirm;

  React.useEffect(() => {
    setOptimisticRefs(
      (input) => addRef.current(input),
      (input) => removeRef.current(input),
      (input) => confirmRef.current(input),
    );
  }, []);

  React.useEffect(() => startWorktreeTopologySync(), []);

  return null;
};

const MiniChatPresenceBridge: React.FC = () => {
  React.useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;

    const channel = new BroadcastChannel(MINI_CHAT_PRESENCE_CHANNEL);
    channel.onmessage = (event) => {
      const data = event.data as MiniChatPresenceMessage | null;
      if (data?.type !== 'mini-chat-session-presence' || !data.sessionId || !data.directory) {
        return;
      }

      const viewed = data.viewed !== false;
      setExternallyViewedSession(data.directory, data.sessionId, viewed);
      if (viewed) {
        markSessionViewed(data.sessionId);
      }
    };

    return () => channel.close();
  }, []);

  return null;
};

export function SyncRuntimeEffects({ embeddedBackgroundWorkEnabled }: {
  embeddedBackgroundWorkEnabled: boolean;
}) {
  // Retention remains available from Settings, but never triggers a broad
  // catalog fetch during normal startup.
  useSessionAutoCleanup({ enabled: embeddedBackgroundWorkEnabled, autoRun: false });
  const queueOwnershipGate = React.useSyncExternalStore(subscribeQueuedMessageOwnershipGate, getQueuedMessageOwnershipGate, getQueuedMessageOwnershipGate);
  useQueuedMessageAutoSend(embeddedBackgroundWorkEnabled && queueOwnershipGate === 'legacy-enabled');
  useQueueAbortOptimisticReconcile();

  React.useEffect(() => {
    const runtime = getMessageQueueServerRuntime();
    const cutover = getMessageQueueCutover();
    runtime.start();
    cutover.start();
    const uninstallRuntimeSwitch = installMessageQueueServerRuntimeSwitch(runtime);
    return () => {
      uninstallRuntimeSwitch();
      cutover.stop();
      runtime.stop();
    };
  }, []);

  return <SyncOptimisticBridge />;
}

export function SyncAppEffects({ embeddedBackgroundWorkEnabled }: {
  embeddedBackgroundWorkEnabled: boolean;
}) {
  usePwaManifestSync();
  useWindowControlsOverlayLayout();
  useKeyboardShortcuts();
  useWorktreeOrderSync();

  React.useEffect(() => {
    restoreWebviewZoomFactor();
  }, []);

  return (
    <>
      <SyncRuntimeEffects embeddedBackgroundWorkEnabled={embeddedBackgroundWorkEnabled} />
      <MiniChatPresenceBridge />
    </>
  );
}
