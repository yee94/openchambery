import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dict } from '@/lib/i18n/messages/en';
import { QueuedMessageChips } from './QueuedMessageChips';
import type { SessionInboxChip } from '@/sync/session-inbox-overlay';

const fixture = vi.hoisted(() => ({ items: [] as unknown[], mode: 'legacy' }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof dict) => dict[key] }) }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: vi.fn() }));
vi.mock('@/sync/message-queue-server-runtime', () => ({ isMessageQueuePendingAdmissionItem: (item: { kind?: string }) => item.kind === 'pending-admission' }));
vi.mock('@/sync/queue-abort-optimistic', () => ({ isQueueItemSendPendingByAbortOptimistic: () => false, subscribeQueueAbortOptimistic: () => () => {}, getQueueAbortOptimisticRevision: () => 0 }));
vi.mock('@/sync/use-message-queue-server', () => ({ useMessageQueueServerScope: () => ({ mode: fixture.mode, items: fixture.items, runtimeCapture: { generation: 1 }, actions: {}, scope: null }) }));
vi.mock('@/hooks/useQueuedMessageAutoSend', () => ({ useQueueScopeDispatchFlight: () => false }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (state: { isMobile: boolean }) => unknown) => select({ isMobile: false }) }));
vi.mock('./MessageReferenceChip', () => ({ MessageReferenceChip: () => null }));
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
const inbox: SessionInboxChip = { kind: 'session-inbox', requestID: 'inbox', queueItemID: 'inbox', operationID: 'inbox', messageID: 'inbox', content: 'Next task', delivery: 'queue', createdAt: 1, attachmentCount: 0 };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.items = []; fixture.mode = 'legacy';
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); });
async function render(items: SessionInboxChip[] = []) {
  await act(async () => root.render(<QueryClientProvider client={client}><QueuedMessageChips
    onEditMessage={() => true} onSendMessage={() => {}} draftKey={null} draftTarget={null}
    scope={{ state: 'bound', transportIdentity: 'test', runtimeGeneration: 1, directory: '/a', sessionID: 's', deliveryTarget: { kind: 'primary' } }}
    clientPendingItems={items}
  /></QueryClientProvider>));
}
it('shows inherited execution configuration on native queued inbox with accessible description', async () => {
  await render([inbox]);
  const hint = Array.from(host.querySelectorAll('[id]')).find((node) => node.textContent === 'Inherits the session model, agent, and variant at execution.');
  expect(hint).toBeDefined();
  expect(host.querySelector(`[aria-describedby="${hint?.id}"]`)).not.toBeNull();
});
it('keeps steer and captured Host/Assistant queue copy separate and empty shell collapsed', async () => {
  await render([{ ...inbox, delivery: 'steer' }]); expect(host.textContent).not.toContain('Inherits');
  fixture.mode = 'server';
  fixture.items = [{ queueItemID: 'captured', operationID: 'op', messageID: 'msg', content: 'Captured task', status: 'queued', attemptCount: 0, position: 0, rowVersion: 1, createdAt: 1 }];
  await render(); expect(host.textContent).toContain('Captured task'); expect(host.textContent).not.toContain('Inherits');
  fixture.items = []; await render(); expect(host.querySelector('[data-oc-queue-card]')).toBeNull();
});
