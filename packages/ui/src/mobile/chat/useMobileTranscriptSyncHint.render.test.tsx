import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  renderable: false,
  status: 'loading' as 'loading' | 'ready' | 'error',
  refresh: false,
  resync: false,
}));

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/useConfigStore', () => ({
  useConfigStore: (selector: (value: object) => unknown) => selector({ isConnected: true, connectionPhase: 'connected' }),
}));
vi.mock('@/sync/sync-context', () => ({
  useSessionMaterializationStatus: () => ({ hasMessages: true, renderable: state.renderable, missingPartMessageIDs: state.renderable ? [] : ['a0'] }),
  useSessionMessageLoadState: () => ({ status: state.status }),
}));
vi.mock('@/sync/transcript-authority-refresh-flight', () => ({
  subscribeTranscriptAuthorityRefresh: () => () => undefined,
  isTranscriptAuthorityRefreshInFlight: () => state.refresh,
}));
vi.mock('@/sync/transcript-resync-flight', () => ({
  subscribeTranscriptResync: () => () => undefined,
  isTranscriptResyncInFlight: () => state.resync,
}));

import { MobileChatHeader } from './MobileChatHeader';
import { useMobileTranscriptSyncHint } from './useMobileTranscriptSyncHint';

function Header({ session, directory }: { session: string; directory: string }) {
  const subtitle = useMobileTranscriptSyncHint(session, directory);
  return <MobileChatHeader title={session} subtitle={subtitle} onBack={() => undefined} onOpenMenu={() => undefined} />;
}

describe('mobile title transcript synchronization', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(state, { renderable: false, status: 'loading', refresh: false, resync: false });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  });
  const render = async (session = 'ses_a', directory = '/workspace') => {
    await act(async () => root.render(<Header session={session} directory={directory} />));
  };
  const advance = async (milliseconds: number) => {
    await act(async () => vi.advanceTimersByTime(milliseconds));
  };
  const subtitle = () => host.querySelector('.oc-mobile-detail-subtitle');

  test('metadata-first loading shows below the title until content is renderable', async () => {
    await render();
    await advance(250);
    expect(subtitle()?.textContent).toBe('mobile.chat.syncingMessages');
    state.status = 'ready';
    await render();
    await advance(1200);
    expect(subtitle()).not.toBeNull();
    state.renderable = true;
    await render();
    await advance(1000);
    expect(subtitle()).toBeNull();
    expect(host.querySelector('.oc-mobile-detail-title')?.textContent).toBe('ses_a');
  });

  test('settled failure stops syncing and a retry starts it again', async () => {
    await render();
    await advance(250);
    state.status = 'error';
    await render();
    await advance(1000);
    expect(subtitle()).toBeNull();
    state.status = 'loading';
    await render();
    await advance(250);
    expect(subtitle()).not.toBeNull();
  });

  test.each(['session', 'directory'] as const)('switching %s immediately drops the previous scope whisper and timer', async (kind) => {
    await render();
    await advance(250);
    expect(subtitle()).not.toBeNull();
    state.renderable = true;
    state.status = 'ready';
    await render(kind === 'session' ? 'ses_b' : 'ses_a', kind === 'directory' ? '/other' : '/workspace');
    expect(subtitle()).toBeNull();
    await advance(1500);
    expect(subtitle()).toBeNull();
  });

  test('a warm background resync keeps the subtitle until its flight ends', async () => {
    state.renderable = true;
    state.status = 'ready';
    state.resync = true;
    await render();
    await advance(250);
    expect(subtitle()).not.toBeNull();
    state.resync = false;
    await render();
    await advance(1000);
    expect(subtitle()).toBeNull();
  });
});
