import { describe, expect, test } from 'vitest';

import {
  buildLynxTurnCard,
  parseLynxMessageParts,
  parseLynxPermissionRequest,
  parseLynxQuestionRequest,
  projectLynxActivity,
} from './messageParts';

describe('Lynx message parts / turn cards', () => {
  test('parses Cap text/reasoning/tool/file parts and rejects empty reasoning', () => {
    const parts = parseLynxMessageParts([
      { id: 't1', type: 'text', text: 'hello' },
      { id: 'r1', type: 'reasoning', text: '   ' },
      { id: 'r2', type: 'reasoning', text: 'think' },
      { id: 'tool1', type: 'tool', tool: 'bash', state: { status: 'running', title: 'ls' } },
      { id: 'f1', type: 'file', mime: 'image/png', filename: 'a.png' },
      { id: 'x1', type: 'step-start' },
    ]);
    expect(parts.map((p) => p.type)).toEqual(['text', 'reasoning', 'tool', 'file', 'other']);
    expect(parts.find((p) => p.type === 'other')).toMatchObject({ rawType: 'step-start' });
  });

  test('collapsed Activity hides rows; expanded lists tools + reasoning', () => {
    const parts = parseLynxMessageParts([
      { type: 'tool', tool: 'read', state: { status: 'completed' } },
      { type: 'reasoning', text: 'why' },
      { type: 'text', text: 'done' },
    ]);
    const collapsed = projectLynxActivity(parts, { expanded: false });
    expect(collapsed?.rows).toEqual([]);
    expect(collapsed?.headerLabel).toContain('Processed');
    const expanded = projectLynxActivity(parts, { expanded: true });
    expect(expanded?.rows).toHaveLength(2);
    const card = buildLynxTurnCard({
      messageId: 'm1',
      role: 'assistant',
      parts,
      activityExpanded: false,
    });
    expect(card.activity?.rows).toEqual([]);
    expect(card.bodyText).toBe('done');
  });

  test('question / permission parsers match Cap request shapes', () => {
    const question = parseLynxQuestionRequest({
      id: 'q1',
      sessionID: 'ses',
      questions: [{
        question: 'Which?',
        header: 'Choose',
        options: [{ label: 'A', description: 'opt a' }],
      }],
    });
    expect(question?.questions[0]?.options[0]?.label).toBe('A');
    expect(parseLynxQuestionRequest({ id: 'q', questions: [] })).toBeNull();

    const permission = parseLynxPermissionRequest({
      id: 'p1',
      sessionID: 'ses',
      permission: 'edit',
      patterns: ['src/**'],
      always: ['edit'],
    });
    expect(permission?.permission).toBe('edit');
    expect(parseLynxPermissionRequest({ id: 'p', sessionID: 'ses' })).toBeNull();
  });

  test('does not invent part types — unknown stays other with rawType', () => {
    const parts = parseLynxMessageParts([{ type: 'made-up-lynx-kind', text: 'nope' }]);
    expect(parts).toEqual([{ type: 'other', id: 'made-up-lynx-kind_0', rawType: 'made-up-lynx-kind' }]);
  });
});
