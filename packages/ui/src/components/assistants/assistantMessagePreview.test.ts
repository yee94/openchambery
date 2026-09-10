import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAssistantDTO } from '@/queries/assistantDTO';
import type { AssistantLatestMessagePreview } from '@/queries/assistantDTO';
// @ts-expect-error Shared server contract fixture is JavaScript.
import { assistantContractFixtures } from '../../../../web/server/lib/assistants/contracts.js';
import { ASSISTANT_MESSAGE_PREVIEW_CLASS, getAssistantMessagePreview } from './assistantMessagePreview';

const preview: AssistantLatestMessagePreview = { messageID: 'm2', ordinal: 2, role: 'assistant', text: '最新消息', fallbackKind: null };
const t = (key: string) => key;

describe('Assistant snapshot message preview', () => {
  test('keeps the server-selected latest user or assistant message', () => {
    for (const role of ['user', 'assistant'] as const) {
      const assistant = parseAssistantDTO({ ...assistantContractFixtures.assistant, latestMessagePreview: { ...preview, role } });
      expect(assistant.latestMessagePreview).toEqual({ ...preview, role });
      expect(getAssistantMessagePreview(assistant.latestMessagePreview, t)).toBe('最新消息');
    }
  });

  test('normalizes legacy absence and authoritative empty history', () => {
    for (const latestMessagePreview of [undefined, null]) {
      const assistant = parseAssistantDTO({ ...assistantContractFixtures.assistant, latestMessagePreview });
      expect(assistant.latestMessagePreview).toBeNull();
      expect(getAssistantMessagePreview(assistant.latestMessagePreview, t)).toBe('assistants.contact.empty');
    }
  });

  test('rejects malformed preview contracts and internal roles', () => {
    for (const patch of [{ ordinal: -1 }, { ordinal: 1.5 }, { role: 'tool' }, { role: 'peer' }, { text: null }, { fallbackKind: 'tool' }]) {
      expect(() => parseAssistantDTO({ ...assistantContractFixtures.assistant, latestMessagePreview: { ...preview, ...patch } })).toThrow();
    }
  });

  test('uses readable attachment/card labels and preserves supplied titles', () => {
    const keys = { image: 'assistants.contact.attachment.image', file: 'assistants.contact.attachment.file', session: 'assistants.contact.card.session.untitled', assistant: 'assistants.title', schedule: 'assistants.settings.scheduledTasks.title' } as const;
    for (const fallbackKind of Object.keys(keys) as Array<keyof typeof keys>) {
      expect(getAssistantMessagePreview({ ...preview, fallbackKind, text: '' }, t)).toBe(keys[fallbackKind]);
      expect(getAssistantMessagePreview({ ...preview, fallbackKind, text: '  标题\n filename.txt  ' }, t)).toBe('标题 filename.txt');
    }
    expect(getAssistantMessagePreview({ ...preview, text: ' \n ' }, t)).toBe('assistants.contact.empty');
  });

  test('shares two-line wrapping across both lists using snapshot only', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = await Promise.all(['AssistantView.tsx', '../../mobile/assistant/MobileAssistantTab.tsx'].map((path) => readFile(join(here, path), 'utf8')));
    for (const source of sources) {
      expect(source).toContain('ASSISTANT_MESSAGE_PREVIEW_CLASS');
      expect(source).toContain('.latestMessagePreview, t)');
      expect(source).not.toContain('defaultPrompt.trim()');
      expect(source).not.toContain('useAssistantContactMessagesQuery');
    }
    expect(ASSISTANT_MESSAGE_PREVIEW_CLASS).toContain('line-clamp-2');
    expect(ASSISTANT_MESSAGE_PREVIEW_CLASS).toContain('[overflow-wrap:anywhere]');
  });
});
