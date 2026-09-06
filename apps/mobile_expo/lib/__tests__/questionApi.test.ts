import { describe, expect, it } from 'vitest';

import {
  applyQuestionEvent,
  parseQuestionList,
  parseQuestionRequest,
} from '@/lib/questionApi';

describe('parseQuestionRequest / list', () => {
  it('parses Cap QuestionRequest shape', () => {
    const parsed = parseQuestionRequest({
      id: 'q1',
      sessionID: 'ses_1',
      questions: [
        {
          question: 'Ship it?',
          header: 'Deploy',
          options: [{ label: 'Yes', description: 'go' }, { label: 'No', description: '' }],
          multiple: false,
        },
      ],
      tool: { messageID: 'm1', callID: 'c1' },
    });
    expect(parsed).toMatchObject({
      id: 'q1',
      sessionID: 'ses_1',
      questions: [{ question: 'Ship it?', header: 'Deploy' }],
      tool: { messageID: 'm1', callID: 'c1' },
    });
    expect(parseQuestionList([parsed, { id: 'bad' }])).toHaveLength(1);
  });
});

describe('applyQuestionEvent', () => {
  const base = {
    id: 'q1',
    sessionID: 'ses_1',
    questions: [{ question: 'A?', header: '', options: [] }],
  };

  it('upserts question.asked and removes replied/rejected', () => {
    let pending = applyQuestionEvent([], { type: 'question.asked', properties: base }, 'ses_1');
    expect(pending).toHaveLength(1);
    pending = applyQuestionEvent(
      pending,
      {
        type: 'question.asked',
        properties: { ...base, questions: [{ question: 'B?', header: '', options: [] }] },
      },
      'ses_1',
    );
    expect(pending[0]?.questions[0]?.question).toBe('B?');
    pending = applyQuestionEvent(
      pending,
      { type: 'question.replied', properties: { sessionID: 'ses_1', requestID: 'q1' } },
      'ses_1',
    );
    expect(pending).toHaveLength(0);
  });

  it('ignores other sessions', () => {
    const pending = applyQuestionEvent([], { type: 'question.asked', properties: base }, 'ses_other');
    expect(pending).toHaveLength(0);
  });
});
