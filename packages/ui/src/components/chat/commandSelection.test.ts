import { describe, expect, test } from 'bun:test';
import { getSlashTokenRange, isCommandAllowedForSubmission, shouldSubmitCommandOnSelection } from './commandSelection';

describe('shouldSubmitCommandOnSelection', () => {
  test('submits commands selected with an immediate-submit interaction', () => {
    expect(shouldSubmitCommandOnSelection({ source: 'openchamber' }, true)).toBe(true);
    expect(shouldSubmitCommandOnSelection({ source: 'opencode', isBuiltIn: true }, true)).toBe(true);
  });

  test('keeps durable references and insert-only interactions in the composer', () => {
    expect(shouldSubmitCommandOnSelection({ source: 'skill', isSkill: true }, true)).toBe(false);
    expect(shouldSubmitCommandOnSelection({ source: 'opencode', isBuiltIn: false }, true)).toBe(false);
    expect(shouldSubmitCommandOnSelection({ source: 'openchamber' }, false)).toBe(false);
  });
});

describe('getSlashTokenRange', () => {
  test('selects the slash token immediately before the caret', () => {
    expect(getSlashTokenRange('context /rev suffix', 12)).toEqual({ start: 8, end: 12 });
    expect(getSlashTokenRange('/review', 7)).toEqual({ start: 0, end: 7 });
  });

  test('preserves text outside the active token range', () => {
    const text = 'before /rev after';
    const range = getSlashTokenRange(text, 11);
    expect(range && `${text.slice(0, range.start)}/review${text.slice(range.end)}`).toBe('before /review after');
  });

  test('requires a slash at the current token boundary', () => {
    expect(getSlashTokenRange('path/to', 7)).toBeNull();
    expect(getSlashTokenRange('plain text', 10)).toBeNull();
  });
});

describe('command policy', () => {
  const policy = (command: { name: string }) => command.name !== 'fork' && command.name !== 'thread';

  test('guards selected commands before insertion or execution', () => {
    expect(isCommandAllowedForSubmission('fork', policy)).toBe(false);
    expect(isCommandAllowedForSubmission('compact', policy)).toBe(true);
  });

  test('guards manual, pasted, and dictated final text through the same name check', () => {
    expect(isCommandAllowedForSubmission('fork', policy)).toBe(false);
    expect(isCommandAllowedForSubmission('thread', policy)).toBe(false);
    expect(isCommandAllowedForSubmission('compact', policy)).toBe(true);
  });
});
