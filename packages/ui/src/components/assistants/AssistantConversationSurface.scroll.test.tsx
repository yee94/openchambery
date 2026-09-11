import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { AssistantDTO } from '@/queries/assistantDTO';

const contactEvents = vi.hoisted(() => ({
  handler: null as ((event: Record<string, unknown>) => void) | null,
}));
const contactQueryState = vi.hoisted(() => ({ extraMessages: 0, earlier: 0, hasPreviousPage: false, isFetchingPreviousPage: false, previousPageError: null as Error | null, fetchPreviousPage: vi.fn(), hasMessageGap: false, isFillingMessageGap: false, retryMessageGap: vi.fn() }));
const attachmentIO = vi.hoisted(() => ({ upload: vi.fn(), send: vi.fn(), abort: vi.fn(), display: vi.fn(), blob: vi.fn(), release: vi.fn() }));
const unreadUI = vi.hoisted(() => ({ settingsOpen: false }));
vi.mock('./AssistantReadMarker', () => ({
  AssistantReadMarker: ({ position }: { position: { ordinal: number; messageID: string } }) => <span data-test-read-ordinal={position.ordinal} data-test-read-message={position.messageID} />,
}));
vi.mock('@/lib/assistant-attachment-upload', () => ({ uploadAssistantAttachment: attachmentIO.upload }));
vi.mock('@/lib/assistant-attachment-cache', () => ({ getAssistantAttachmentDisplay: attachmentIO.display, getAssistantAttachmentBlob: attachmentIO.blob }));
vi.mock('@/components/chat/imageSource', () => ({ useRuntimeTransportIdentity: () => 'test', useResolvedImageSource: (url: string) => url }));
vi.mock('@/queries/sessionIndexQueries', () => ({ sessionIndexSnapshotQueryOptions: vi.fn() }));

vi.mock('@/components/chat/ChatPromptComposer', () => ({
  ChatPromptComposer: (props: { value: string; pending: boolean; onStop?: () => void; attachments: { id: string; name: string }[]; onChange: (value: string) => void; onSubmit: () => void; onAddFiles: (files: FileList | null) => void }) => <div data-test-composer="">
    <textarea value={props.value} onInput={(event) => props.onChange(event.currentTarget.value)} />
    <input type="file" onChange={(event) => props.onAddFiles(event.currentTarget.files)} />
    {props.attachments.map((attachment) => <span key={attachment.id} data-preview="">{attachment.name}</span>)}
    <button type="button" data-stop="" hidden={!props.pending || !props.onStop} onClick={props.onStop}>Stop</button>
    <button type="button" data-send="" disabled={props.pending} onClick={props.onSubmit}>Send</button>
  </div>,
}));
vi.mock('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/openchamberEvents', () => ({
  subscribeOpenchamberEvents: (handler: (event: Record<string, unknown>) => void) => {
    contactEvents.handler = handler;
    return () => { contactEvents.handler = null; };
  },
}));
vi.mock('@/apps/MobileShareBridge', () => ({
  donateNativeAssistantInteraction: () => Promise.resolve(),
}));
vi.mock('@/stores/useUIStore', () => ({
  useUIStore: (selector: (state: { isMobile: boolean; isSettingsDialogOpen: boolean }) => unknown) => selector({ isMobile: false, isSettingsDialogOpen: unreadUI.settingsOpen }),
}));
vi.mock('@/queries/assistantQueries', () => ({
  abortAssistantSession: attachmentIO.abort,
  sendAssistantContactMessage: attachmentIO.send,
  useAssistantCapabilityQuery: () => ({ data: null }),
  useAssistantContactMessagesQuery: (assistantID: string) => ({
    data: {
      messages: [
        ...Array.from({ length: contactQueryState.earlier }, (_, index) => ({
          messageID: `earlier:${index}`, assistantID, role: 'assistant', turnID: `earlier:${index}`, bubbleIndex: 0, createdAt: 0, ordinal: index, status: 'complete', fromAssistantID: null, fromAssistantName: null, parts: [{ type: 'text', text: `older ${index}` }], text: '', cards: [],
        })),
        {
          messageID: `${assistantID}:user`,
          assistantID,
          role: 'user',
          turnID: `${assistantID}:turn`,
          bubbleIndex: 0,
          createdAt: 1,
          ordinal: 0,
          status: 'complete',
          fromAssistantID: null,
          fromAssistantName: null,
          parts: [{ type: 'text', text: 'hello' }],
          text: 'hello',
          cards: [],
        },
        ...Array.from({ length: contactQueryState.extraMessages }, (_, index) => ({
          messageID: `${assistantID}:refetch:${index}`,
          assistantID,
          role: 'assistant',
          turnID: `${assistantID}:refetch-turn:${index}`,
          bubbleIndex: 0,
          createdAt: index + 2,
          ordinal: index + 1,
          status: 'complete',
          fromAssistantID: null,
          fromAssistantName: null,
          parts: [{ type: 'text', text: `refetched ${index}` }],
          text: `refetched ${index}`,
          cards: [],
        })),
      ],
      nextCursor: null,
      complete: true,
      generation: 0,
    },
    isError: false,
    isSuccess: true,
    hasPreviousPage: contactQueryState.hasPreviousPage,
    isFetchingPreviousPage: contactQueryState.isFetchingPreviousPage,
    previousPageError: contactQueryState.previousPageError,
    fetchPreviousPage: contactQueryState.fetchPreviousPage,
    hasMessageGap: contactQueryState.hasMessageGap,
    isFillingMessageGap: contactQueryState.isFillingMessageGap,
    retryMessageGap: contactQueryState.retryMessageGap,
  }),
  useAssistantSnapshotQuery: () => ({ data: { assistants: [] } }),
}));
vi.mock('./assistantPresentation', () => ({
  getAssistantPresentation: (name: string) => ({ displayName: name, avatarEmoji: null }),
}));
vi.mock('./AssistantAssistantCard', () => ({ AssistantAssistantCard: () => null }));
vi.mock('./AssistantScheduleCard', () => ({ AssistantScheduleCard: () => null }));
vi.mock('./AssistantSessionCard', () => ({ AssistantSessionCard: () => null }));
vi.mock('./AssistantWorkingAvatar', () => ({ AssistantWorkingAvatar: () => null }));
vi.mock('./assistantWorking', () => ({
  useAssistantContactWorkingStore: (selector: (state: { setWorking: () => void }) => unknown) => (
    selector({ setWorking: () => undefined })
  ),
}));

import { AssistantConversationSurface } from './AssistantConversationSurface';
import { AssistantContactAttachment } from './AssistantContactAttachment';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const assistant = (id: string): AssistantDTO => ({
  id,
  revision: 1,
  enabled: true,
  name: id,
  defaultPrompt: '',
  workspacePath: null,
  effectiveWorkspacePath: '/workspace',
  managedWorkspacePath: null,
  providerID: 'provider',
  modelID: 'model',
  agent: null,
  variant: null,
  mode: 'continuous',
  sessionID: null,
  sessionGeneration: 0,
  historySessionIDs: [],
  historySessionCount: 0,
  assignedSessionIDs: [],
  working: false,
  activeContactTurn: null,
  createdAt: 1,
  updatedAt: 1,
  tombstoneAt: null,
});

const mountedRoots: Array<{ root: ReturnType<typeof createRoot>; host: HTMLDivElement }> = [];

const mountSurface = async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push({ root, host });
  await act(async () => {
    root.render(<AssistantConversationSurface assistant={assistant('assistant-a')} active />);
  });
  const scroller = host.querySelector<HTMLElement>('[data-assistant-contact-transcript]');
  if (!scroller) throw new Error('contact transcript scroller missing');
  return { root, host, scroller };
};

afterEach(async () => {
  for (const mounted of mountedRoots.splice(0)) {
    await act(async () => { mounted.root.unmount(); });
    mounted.host.remove();
  }
  contactEvents.handler = null;
  contactQueryState.extraMessages = 0;
  contactQueryState.earlier = 0;
  contactQueryState.hasPreviousPage = false;
  contactQueryState.isFetchingPreviousPage = false;
  contactQueryState.previousPageError = null;
  contactQueryState.hasMessageGap = false;
  contactQueryState.isFillingMessageGap = false;
  unreadUI.settingsOpen = false;
  vi.clearAllMocks();
});

describe('AssistantConversationSurface scroll ownership', () => {
  test('read marker belongs to the loaded row and detaches for inactive, settings and gap surfaces', async () => {
    contactQueryState.extraMessages = 1;
    const { root, host } = await mountSurface();
    const item = { ...assistant('assistant-a'), unreadCount: 3, readTip: { generation: 0, ordinal: 20, messageID: 'newer-unloaded' }, readWatermark: { generation: 0, ordinal: 0, messageID: '' } };
    await act(async () => root.render(<AssistantConversationSurface assistant={item} active />));
    expect(host.querySelector('[data-test-read-ordinal]')?.getAttribute('data-test-read-message')).toBe('assistant-a:refetch:0');
    await act(async () => root.render(<AssistantConversationSurface assistant={item} active={false} />));
    expect(host.querySelector('[data-test-read-ordinal]')).toBeNull();
    unreadUI.settingsOpen = true;
    await act(async () => root.render(<AssistantConversationSurface assistant={item} active />));
    expect(host.querySelector('[data-test-read-ordinal]')).toBeNull();
    unreadUI.settingsOpen = false;
    contactQueryState.hasMessageGap = true;
    await act(async () => root.render(<AssistantConversationSurface assistant={item} active />));
    expect(host.querySelector('[data-test-read-ordinal]')).toBeNull();
    contactQueryState.hasMessageGap = false;
    await act(async () => root.render(<AssistantConversationSurface assistant={{ ...item, readTip: { ...item.readTip, generation: 1 } }} active />));
    expect(host.querySelector('[data-test-read-ordinal]')).toBeNull();
  });

  test('session references retain their exact plain-text payload and retry identity through failed admission', async () => {
    const text = 'Watch @session:ses_existing {"title":"Existing work","sessionID":"ses_existing","directory":"/repo/existing"}';
    attachmentIO.send.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ revision: 1 });
    const { host } = await mountSurface();
    const textarea = host.querySelector('textarea')!;
    await act(async () => {
      textarea.value = text;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(attachmentIO.send).not.toHaveBeenCalled();
    const send = host.querySelector<HTMLButtonElement>('[data-send]')!;
    await act(async () => send.click());
    expect(textarea.value).toBe(text);
    expect(attachmentIO.send.mock.calls[0][2]).toEqual({ parts: [{ type: 'text', text }] });
    await act(async () => send.click());
    expect(attachmentIO.send.mock.calls[1]).toEqual(attachmentIO.send.mock.calls[0]);
    expect(textarea.value).toBe('');
  });

  test('gap recovery shows its status and disables retry while filling', async () => {
    contactQueryState.hasMessageGap = true;
    contactQueryState.retryMessageGap.mockResolvedValue(undefined);
    const { host, root } = await mountSurface();
    expect(host.querySelector('[role="status"]')?.textContent).toBe('assistants.contact.history.gap');
    await act(async () => host.querySelector<HTMLButtonElement>('[data-assistant-contact-pagination] button')!.click());
    expect(contactQueryState.retryMessageGap).toHaveBeenCalledTimes(1);
    expect(contactQueryState.fetchPreviousPage).toHaveBeenCalledTimes(0);
    contactQueryState.isFillingMessageGap = true;
    await act(async () => root.render(<AssistantConversationSurface assistant={assistant('assistant-a')} active />));
    const button = host.querySelector<HTMLButtonElement>('[data-assistant-contact-pagination] button')!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('chat.history.loadingMore');
  });

  test('non-image attachments download verified Blobs only after a click and retry failure', async () => {
    const part = { type: 'file' as const, attachmentID: 'attachment-a', sha256: 'a'.repeat(64), size: 3, mime: 'text/plain', filename: 'note.txt' };
    attachmentIO.blob.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(new Blob(['abc']));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    try {
      const { root, host } = await mountSurface();
      await act(async () => root.render(<AssistantContactAttachment assistantID="assistant-a" part={part} />));
      expect(attachmentIO.blob).toHaveBeenCalledTimes(0);
      expect(attachmentIO.display).toHaveBeenCalledTimes(0);
      await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
      expect(host.querySelector('[role="alert"]')).toBeTruthy();
      await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
      expect(click).toHaveBeenCalledTimes(1);
      expect(attachmentIO.blob).toHaveBeenCalledTimes(2);
      expect(host.querySelector('[role="alert"]')).toBeNull();
    } finally { click.mockRestore(); }
  });
  test('equivalent polled attachment descriptors reuse the display lease and release on removal', async () => {
    const part = { type: 'file' as const, attachmentID: 'attachment-a', sha256: 'a'.repeat(64), size: 3, mime: 'image/png', filename: 'shot.png' };
    attachmentIO.display.mockResolvedValue({ url: 'openchamber-asset://image', release: attachmentIO.release });
    const { root, host } = await mountSurface();
    await act(async () => root.render(<AssistantContactAttachment assistantID="assistant-a" part={part} />));
    expect(host.querySelector('img')?.getAttribute('src')).toBe('openchamber-asset://image');
    for (let index = 0; index < 20; index += 1) {
      await act(async () => root.render(<AssistantContactAttachment assistantID="assistant-a" part={{ ...part }} />));
    }
    expect(attachmentIO.display).toHaveBeenCalledTimes(1);
    const signal = attachmentIO.display.mock.calls[0][2].signal as AbortSignal;
    await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
    expect(attachmentIO.release).toHaveBeenCalledTimes(1);
  });

  test('attachment failure provides a working retry and late completions release their lease', async () => {
    const part = { type: 'file' as const, attachmentID: 'attachment-a', sha256: 'a'.repeat(64), size: 3, mime: 'image/png' };
    let complete!: (display: { url: string; release: () => void }) => void;
    attachmentIO.display.mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const { root, host } = await mountSurface();
    await act(async () => root.render(<AssistantContactAttachment assistantID="assistant-a" part={part} />));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('assistants.contact.attachment.loadFailed');
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
    expect(host.querySelector('[role="status"]')).toBeTruthy();
    await act(async () => { root.render(null); });
    await act(async () => complete({ url: 'blob:late', release: attachmentIO.release }));
    expect(attachmentIO.release).toHaveBeenCalledTimes(1);
  });
  test('top button and upward gesture share one flight; failures retain rows and expose retry', async () => {
    contactQueryState.hasPreviousPage = true;
    let finish!: () => void;
    contactQueryState.fetchPreviousPage.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { root, host, scroller } = await mountSurface();
    const button = host.querySelector<HTMLButtonElement>('[data-assistant-contact-pagination] button')!;
    await act(async () => { button.click(); button.click(); scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -80, bubbles: true })); });
    expect(contactQueryState.fetchPreviousPage).toHaveBeenCalledTimes(1);
    contactQueryState.previousPageError = new Error('offline');
    await act(async () => { finish(); root.render(<AssistantConversationSurface assistant={assistant('assistant-a')} active />); });
    expect(host.querySelector('[data-message-id="assistant-a:user"]')).toBeTruthy();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('chat.history.loadOlderFailed');
    await act(async () => { scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -80, bubbles: true })); });
    expect(contactQueryState.fetchPreviousPage).toHaveBeenCalledTimes(1);
    await act(async () => { button.click(); });
    expect(contactQueryState.fetchPreviousPage).toHaveBeenCalledTimes(2);
    await act(async () => finish());
  });

  test('prepend restores the first visible message ID and offset synchronously', async () => {
    contactQueryState.hasPreviousPage = true;
    let finish!: () => void;
    contactQueryState.fetchPreviousPage.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { root, host, scroller } = await mountSurface();
    let top = 30;
    Object.defineProperties(scroller, { scrollTop: { configurable: true, get: () => top, set: (value) => { top = value; } }, clientHeight: { configurable: true, value: 300 }, scrollHeight: { configurable: true, get: () => 900 + contactQueryState.earlier * 100 } });
    const row = host.querySelector<HTMLElement>('[data-message-id="assistant-a:user"]')!;
    row.getBoundingClientRect = () => ({ top: 50 + contactQueryState.earlier * 100 - top, bottom: 150 + contactQueryState.earlier * 100 - top } as DOMRect);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-assistant-contact-pagination] button')!.click(); });
    const offset = row.getBoundingClientRect().top;
    contactQueryState.earlier = 20;
    await act(async () => { finish(); root.render(<AssistantConversationSurface assistant={assistant('assistant-a')} active />); });
    expect(row.getBoundingClientRect().top).toBe(offset);
    expect(top).toBe(2030);
  });

  test('upload and send failures retain draft previews and retry the same upload/message IDs', async () => {
    const descriptor = { type: 'file', attachmentID: 'attachment-a', sha256: 'a'.repeat(64), size: 3, mime: 'image/png', filename: 'shot.png' };
    attachmentIO.upload.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(descriptor);
    attachmentIO.send.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ revision: 1 });
    attachmentIO.display.mockResolvedValue({ url: 'blob:cached', release: attachmentIO.release });
    const { host } = await mountSurface();
    const textarea = host.querySelector('textarea')!;
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => {
      textarea.value = 'keep my draft'; textarea.dispatchEvent(new Event('input', { bubbles: true }));
      Object.defineProperty(input, 'files', { value: [new File(['img'], 'shot.png', { type: 'image/png' })] });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const send = host.querySelector<HTMLButtonElement>('[data-send]')!;
    await act(async () => send.click());
    expect(textarea.value).toBe('keep my draft');
    expect(host.querySelector('[data-preview]')).toBeTruthy();
    await act(async () => send.click());
    expect(textarea.value).toBe('keep my draft');
    expect(attachmentIO.upload.mock.calls[0][2]).toBe(attachmentIO.upload.mock.calls[1][2]);
    await act(async () => send.click());
    expect(attachmentIO.upload).toHaveBeenCalledTimes(2);
    expect(attachmentIO.send.mock.calls[0][1]).toBe(attachmentIO.send.mock.calls[1][1]);
    expect(attachmentIO.send.mock.calls[1][2].parts[1]).toEqual(descriptor);
    expect(textarea.value).toBe('');
    expect(host.querySelector('[data-preview]')).toBeNull();
  });
  test('matches primary chat overflow-anchor and overscroll containment', async () => {
    const { scroller } = await mountSurface();
    expect(scroller.style.overflowAnchor).toBe('none');
    expect(scroller.style.overscrollBehavior).toBe('contain');
    expect(scroller.style.overscrollBehaviorY).toBe('contain');
  });

  test('keeps the user reading position while a contact reply streams', async () => {
    const { scroller } = await mountSurface();
    let scrollTop = 120;
    let writes = 0;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 300 },
      scrollHeight: { configurable: true, get: () => 900 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; writes += 1; },
      },
    });

    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -80, bubbles: true }));
    scroller.dispatchEvent(new Event('scroll'));
    await act(async () => {
      contactEvents.handler?.({
        type: 'contact-bubble-delta',
        assistantID: 'assistant-a',
        turnID: 'assistant-a:turn',
        bubbleIndex: 0,
        delta: 'stream token',
        done: false,
        occurredAt: 2,
      });
    });

    expect(scrollTop).toBe(120);
    expect(writes).toBe(0);
  });

  test('keeps the user reading position when a contact refetch appends a row', async () => {
    const { root, scroller } = await mountSurface();
    let scrollTop = 180;
    let writes = 0;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 300 },
      scrollHeight: { configurable: true, get: () => 1000 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; writes += 1; },
      },
    });

    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -80, bubbles: true }));
    scroller.dispatchEvent(new Event('scroll'));
    contactQueryState.extraMessages = 1;
    await act(async () => {
      root.render(<AssistantConversationSurface assistant={assistant('assistant-a')} active />);
    });

    expect(scrollTop).toBe(180);
    expect(writes).toBe(0);
  });
});


test('contact stop calls the assistant abort endpoint with a null session and retains working on failure', async () => {
  attachmentIO.abort.mockRejectedValueOnce(new Error('Stop request failed'));
  const { host, root } = await mountSurface();
  const item = { ...assistant('assistant-a'), working: true };
  await act(async () => root.render(<AssistantConversationSurface assistant={item} active />));
  const stop = host.querySelector<HTMLButtonElement>('[data-stop]')!;
  expect(stop.hidden).toBe(false);
  await act(async () => stop.click());
  expect(attachmentIO.abort).toHaveBeenCalledWith('assistant-a', expect.objectContaining({ sessionID: null, sessionGeneration: 0 }));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Stop request failed');
  expect(host.querySelector<HTMLButtonElement>('[data-stop]')!.hidden).toBe(false);
  attachmentIO.abort.mockResolvedValueOnce(undefined);
  await act(async () => stop.click());
  expect(attachmentIO.abort).toHaveBeenCalledTimes(2);
  // Successful HTTP admission also waits for authoritative idle; it must not invent it.
  expect(host.querySelector<HTMLButtonElement>('[data-stop]')!.hidden).toBe(false);
  await act(async () => root.render(<AssistantConversationSurface assistant={{ ...item, working: false }} active />));
  expect(host.querySelector<HTMLButtonElement>('[data-stop]')!.hidden).toBe(true);
});

test.each(['sending', 'serverWorking', 'processing'] as const)('pending send preserves stop for active work (%s)', async (source) => {
  let finish!: (value: { revision: number }) => void;
  attachmentIO.send.mockReset().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  attachmentIO.abort.mockReset().mockResolvedValue(undefined);
  const { host, root } = await mountSurface();
  await act(async () => {
    const textarea = host.querySelector('textarea')!;
    textarea.value = 'Please continue';
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await act(async () => host.querySelector<HTMLButtonElement>('[data-send]')!.click());
  expect(attachmentIO.send).toHaveBeenCalledTimes(1);
  await act(async () => {
    root.render(<AssistantConversationSurface assistant={{ ...assistant('assistant-a'), working: source === 'serverWorking' }} active />);
    if (source === 'processing') contactEvents.handler?.({ type: 'contact-turn-start', assistantID: 'assistant-a', turnID: 'turn-admitted', occurredAt: 2 });
  });
  try {
    const stop = host.querySelector<HTMLButtonElement>('[data-stop]')!;
    expect(stop.hidden).toBe(source === 'sending');
    if (!stop.hidden) await act(async () => stop.click());
    expect(attachmentIO.abort).toHaveBeenCalledTimes(source === 'sending' ? 0 : 1);
    expect(host.querySelector<HTMLButtonElement>('[data-send]')!.disabled).toBe(true);
  } finally {
    await act(async () => finish({ revision: 2 }));
  }
});
