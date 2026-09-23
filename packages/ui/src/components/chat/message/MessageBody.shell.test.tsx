import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Part } from '@opencode-ai/sdk/v2';
import MessageBody from './MessageBody';

const mocks = vi.hoisted(() => ({ copy: vi.fn(async (_text: string) => ({ ok: true })) }));
vi.hoisted(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
    status: 200, headers: { 'content-type': 'application/json' },
  })));
});
vi.mock('../FileAttachment', () => ({ MessageFilesDisplay: () => null }));
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: mocks.copy }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ locale: 'en', t: (key: string) => key }) }));
vi.mock('@/components/code/WorkerHighlightedCode', () => ({
  WorkerHighlightedCode: ({ code }: { code: string }) => <code data-highlighted>{code}</code>,
}));
vi.mock('./parts/UserTextPart', () => ({ default: ({ part }: { part: { text: string } }) => <p>{part.text}</p> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('user shell results', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    mocks.copy.mockClear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = async (output: string, status = 'completed', shell = true) => {
    const parts = [{ type: 'text', text: shell ? '/shell' : 'Ordinary message',
      ...(shell ? { shellAction: { command: 'pwd', output, status } } : {}),
    } as Part];
    await act(async () => root.render(<MessageBody
      messageId="shell-1" parts={parts} isUser isMessageCompleted={status === 'completed'}
      isMobile={false} copiedCode={null} onCopyCode={() => undefined}
      expandedTools={new Set()} onToggleTool={() => undefined} onShowPopup={() => undefined}
      streamPhase="completed" allowAnimation={false} shouldShowHeader={false}
    />));
  };

  test('renders raw output immediately and copies its exact whitespace with feedback', async () => {
    const output = '  /workspace\n<script>literal text</script>\n\n';
    await render(output);
    expect(container.querySelector('pre')?.textContent).toBe(output);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelectorAll('[data-highlighted]')).toHaveLength(1);
    expect(container.querySelector('[data-highlighted]')?.textContent).toBe('pwd');
    expect(container.textContent).not.toMatch(/showOutput|hideOutput|completed/);
    expect(container.querySelectorAll('button')).toHaveLength(1);
    await act(async () => container.querySelector('button')!.click());
    expect(mocks.copy).toHaveBeenCalledWith(output);
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('chat.messageBody.shellCommand.copied');
  });

  test('keeps running and error feedback visible, including empty output', async () => {
    await render('', 'running');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('chat.assistantStatus.runningCommand');
    expect(container.querySelector('button')).toBeNull();
    await render('permission denied\n', 'error');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('chat.toolPart.error');
    expect(container.querySelector('pre')?.textContent).toBe('permission denied\n');
  });

  test('preserves whitespace-only output and ordinary user text rendering', async () => {
    await render(' \n');
    expect(container.querySelector('pre')?.textContent).toBe(' \n');
    await render('', 'completed', false);
    expect(container.textContent).toContain('Ordinary message');
    expect(container.querySelector('pre')).toBeNull();
    expect(container.textContent).not.toContain('chat.messageBody.shellCommand.title');
  });
});
