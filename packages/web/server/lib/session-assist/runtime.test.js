import { describe, expect, test } from 'vitest';
import { buildAssistTranscript } from './runtime.js';

const textPart = (text, { synthetic = false } = {}) => ({
  type: 'text',
  text,
  ...(synthetic ? { synthetic: true } : {}),
});

const userMessage = (id, parts) => ({ info: { id, role: 'user' }, parts });
const assistantMessage = (id, parts) => ({ info: { id, role: 'assistant' }, parts });

describe('buildAssistTranscript', () => {
  test('assistant keeps only the LAST text block of the last assistant message', () => {
    const result = buildAssistTranscript([
      userMessage('u1', [textPart('first user message')]),
      assistantMessage('a1', [textPart('old assistant reply')]),
      userMessage('u2', [textPart('second user message')]),
      assistantMessage('a2', [
        textPart('intro before tools'),
        { type: 'tool', tool: 'bash' },
        textPart('final body text'),
      ]),
    ]);
    expect(result.assistantInfo.id).toBe('a2');
    expect(result.assistantText).toBe('final body text');
    expect(result.transcript).toBe(
      'User:\nfirst user message\n\nUser:\nsecond user message\n\nAssistant:\nfinal body text',
    );
  });

  test('reasoning parts never enter the transcript', () => {
    const result = buildAssistTranscript([
      userMessage('u1', [textPart('请帮我看看')]),
      assistantMessage('a1', [
        { type: 'reasoning', text: 'thinking about the problem' },
        textPart('最终答复'),
      ]),
    ]);
    expect(result.transcript).toBe('User:\n请帮我看看\n\nAssistant:\n最终答复');
    expect(result.transcript).not.toContain('thinking');
  });

  test('user side keeps only the latest 3 real user messages, chronologically', () => {
    const result = buildAssistTranscript([
      userMessage('u1', [textPart('question 1')]),
      assistantMessage('a1', [textPart('answer 1')]),
      userMessage('u2', [textPart('question 2')]),
      assistantMessage('a2', [textPart('answer 2')]),
      userMessage('u3', [textPart('question 3')]),
      userMessage('u4', [textPart('question 4')]),
      assistantMessage('a3', [textPart('answer 3')]),
    ]);
    expect(result.userTexts).toEqual(['question 2', 'question 3', 'question 4']);
    expect(result.transcript).toBe(
      'User:\nquestion 2\n\nUser:\nquestion 3\n\nUser:\nquestion 4\n\nAssistant:\nanswer 3',
    );
  });

  test('synthetic-only user messages do not count toward the user window', () => {
    const result = buildAssistTranscript([
      userMessage('u1', [textPart('visible request')]),
      userMessage('u2', [textPart('hidden instruction', { synthetic: true })]),
      userMessage('u3', [textPart('real follow-up')]),
      assistantMessage('a1', [textPart('reply body')]),
    ]);
    expect(result.userTexts).toEqual(['visible request', 'real follow-up']);
    expect(result.transcript).not.toContain('hidden instruction');
  });

  test('synthetic instruction part on a real user message is dropped', () => {
    const result = buildAssistTranscript([
      userMessage('u1', [
        textPart('visible request'),
        textPart('/summary hidden instructions', { synthetic: true }),
      ]),
      assistantMessage('a1', [textPart('reply body')]),
    ]);
    expect(result.userTexts).toEqual(['visible request']);
    expect(result.transcript).not.toContain('/summary hidden instructions');
  });

  test('fewer than 3 user messages keeps all of them', () => {
    const result = buildAssistTranscript([
      userMessage('u1', [textPart('only question')]),
      assistantMessage('a1', [textPart('only answer')]),
    ]);
    expect(result.userTexts).toEqual(['only question']);
    expect(result.transcript).toBe('User:\nonly question\n\nAssistant:\nonly answer');
  });

  test('no assistant message yields an empty transcript', () => {
    const result = buildAssistTranscript([
      userMessage('u1', [textPart('unanswered question')]),
    ]);
    expect(result.transcript).toBe('');
    expect(result.assistantInfo).toBeNull();
    expect(result.userTexts).toEqual([]);
  });

  test('assistant with no text parts still summarizes the user side', () => {
    const result = buildAssistTranscript([
      userMessage('u1', [textPart('question')]),
      assistantMessage('a1', [{ type: 'tool', tool: 'bash' }]),
    ]);
    expect(result.assistantInfo.id).toBe('a1');
    expect(result.transcript).toBe('User:\nquestion');
  });

  test('empty input yields an empty transcript', () => {
    expect(buildAssistTranscript([]).transcript).toBe('');
    expect(buildAssistTranscript(null).transcript).toBe('');
  });
});
