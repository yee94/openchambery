import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { I18nProvider } from '@/lib/i18n';
import { ContextUsageDisplay } from '@/components/ui/ContextUsageDisplay';
import { ContextProgressIcon } from '@/mobile/chat/ContextProgressIcon';
import { ChildStoreManager } from './child-store';
import { bindTranscriptRepositoryInstance, transcriptScope, unbindTranscriptRepository } from './transcript-repository-runtime';
import { createQueryTranscriptRepository } from './transcript-repository-query-adapter';
import { resetObserveEnsureGate, useTranscriptContextUsage } from './transcript-repository-observers';
import { normalizeSessionProjectionMessage } from './session-projection-api';
import type { Event } from './types';

const directory = '/workspace/context-usage';
const sessionID = 'ses_context_usage';

describe('context usage mounted lifecycle', () => {
  let root: Root;
  let container: HTMLDivElement;
  let store: ReturnType<ChildStoreManager['ensureChild']>;
  let repository: ReturnType<typeof createQueryTranscriptRepository>;
  let client: QueryClient;
  let renders: number;

  function send(type: string, properties: Record<string, unknown> = {}) {
    act(() => {
      repository.apply(transcriptScope(directory, sessionID), {
        type: 'sse-event',
        event: { id: 'evt_compact', type, properties: { sessionID, ...properties } } as Event,
      });
    });
  }

  function Probe({ id = sessionID }: { id?: string }) {
    const usage = useTranscriptContextUsage(id, directory, store, 200000, 1000);
    renders += 1;
    return <I18nProvider>{usage && <>
      <ContextUsageDisplay {...usage} appearance="subtle" />
      <ContextProgressIcon percentage={usage.percentage} pending={usage.pending} />
    </>}</I18nProvider>;
  }

  beforeEach(() => {
    resetObserveEnsureGate();
    unbindTranscriptRepository();
    const manager = new ChildStoreManager();
    store = manager.ensureChild(directory, { bootstrap: false });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    repository = createQueryTranscriptRepository({ client });
    bindTranscriptRepositoryInstance(repository);
    const assistant = normalizeSessionProjectionMessage(sessionID, {
      id: 'msg_before', type: 'assistant', time: { created: 1 }, content: [],
      tokens: { input: 90000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
    })!;
    repository.apply(transcriptScope(directory, sessionID), {
      type: 'http-page', purpose: 'initial', page: { records: [assistant], complete: true, turnCount: 1 },
    });
    renders = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Probe />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    unbindTranscriptRepository();
    repository.destroy();
    client.clear();
    resetObserveEnsureGate();
  });

  test('keeps usage while running/failed, then updates on a part-only completion and new tokens', () => {
    expect(container.textContent).toContain('45.0%');
    send('session.compaction.started', { inputID: 'msg_compact', reason: 'manual' });
    expect(container.textContent).toContain('45.0%');
    const beforeDelta = renders;
    send('session.compaction.delta', { text: 'summary fragment' });
    expect(renders).toBe(beforeDelta);
    send('session.compaction.failed', { error: { type: 'provider.internal', message: 'failed' } });
    expect(container.textContent).toContain('45.0%');

    send('session.compaction.started', { inputID: 'msg_retry', reason: 'manual' });
    const checkpointBefore = repository.getMessage(transcriptScope(directory, sessionID), 'msg_retry');
    send('session.compaction.ended', { text: 'summary', recent: '' });
    expect(repository.getMessage(transcriptScope(directory, sessionID), 'msg_retry')).toBe(checkpointBefore);
    expect(container.textContent).toContain('Awaiting update');
    expect(container.textContent).not.toContain('%');
    for (const ring of container.querySelectorAll('[role="progressbar"]')) {
      expect(ring.hasAttribute('aria-valuenow')).toBe(false);
      expect(ring.getAttribute('aria-valuetext')).toBe('Awaiting update');
    }

    // A fresh observer/revisit derives pending from the checkpoint, not component memory.
    act(() => root.render(<Probe key="revisit" />));
    expect(container.textContent).toContain('Awaiting update');
    const assistant = normalizeSessionProjectionMessage(sessionID, {
      id: 'msg_after', type: 'assistant', time: { created: 3 }, content: [],
      tokens: { input: 10000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })!;
    act(() => {
      repository.apply(transcriptScope(directory, sessionID), {
        type: 'http-page', purpose: 'initial', page: { records: [assistant], complete: true, turnCount: 1 },
      });
    });
    expect(container.textContent).toContain('5.0%');
    expect(container.textContent).not.toContain('Awaiting update');
    act(() => root.render(<Probe id="ses_empty" />));
    expect(container.textContent).toBe('');
  });
});
