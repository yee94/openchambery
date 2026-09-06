import { getMetaStoreBackend } from '@/lib/metaStore';
import type { ShareEnvelope } from '@/lib/systemShell/share';

export type ShareOutboxState =
  | 'pending'
  | 'resolving-instance'
  | 'connecting'
  | 'auth-required'
  | 'offline'
  | 'target-stale'
  | 'dispatching'
  | 'reconciling'
  | 'delivered'
  | 'failed';

export type ShareCleanupPhase = 'server-completed' | 'native-acked' | 'files-released';

export type ShareOutboxItem = {
  envelope: ShareEnvelope;
  messageID: string;
  state: ShareOutboxState;
  cleanupPhase?: ShareCleanupPhase;
  updatedAt: number;
  error?: string;
};

export const SHARE_OUTBOX_KEY = 'openchamber.expo-share.outbox.v1';

export const readShareOutbox = async (): Promise<Record<string, ShareOutboxItem>> => {
  try {
    const raw = await getMetaStoreBackend().getItem(SHARE_OUTBOX_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, ShareOutboxItem>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

export const writeShareOutbox = async (items: Record<string, ShareOutboxItem>): Promise<void> => {
  await getMetaStoreBackend().setItem(SHARE_OUTBOX_KEY, JSON.stringify(items));
};

export const saveShareOutboxItem = async (item: ShareOutboxItem): Promise<void> => {
  const all = await readShareOutbox();
  const existing = all[item.envelope.operationID];
  if (existing && existing.updatedAt > item.updatedAt) return;
  all[item.envelope.operationID] = item;
  await writeShareOutbox(all);
};
