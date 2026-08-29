import { describe, expect, test } from 'vitest';

import { COMPOSER_TRIGGER_ICON_SLOT } from '@/composer/inline-visual';

import { resolveComposerAutocompleteTrigger } from './trigger';

describe('resolveComposerAutocompleteTrigger', () => {
  test('closes in shell mode', () => {
    expect(resolveComposerAutocompleteTrigger({
      text: '/undo',
      cursor: 5,
      inputMode: 'shell',
    })).toBeNull();
  });

  test('opens a leading slash-command palette before the first space', () => {
    expect(resolveComposerAutocompleteTrigger({ text: '/un', cursor: 3 })).toEqual({
      kind: 'slash-command',
      query: 'un',
      tokenStart: 0,
      tokenEnd: 3,
    });
  });

  test('strips the reserved icon slot from a leading slash query', () => {
    const text = `/${COMPOSER_TRIGGER_ICON_SLOT}undo`;
    expect(resolveComposerAutocompleteTrigger({ text, cursor: text.length })).toEqual({
      kind: 'slash-command',
      query: 'undo',
      tokenStart: 0,
      tokenEnd: text.length,
    });
  });

  test('closes the leading slash-command palette after a space', () => {
    expect(resolveComposerAutocompleteTrigger({ text: '/undo hello', cursor: 11 })).toBeNull();
  });

  test('opens mid-line slash skills on a word-boundary slash', () => {
    expect(resolveComposerAutocompleteTrigger({ text: 'please /rev', cursor: 11 })).toEqual({
      kind: 'slash-skill',
      query: 'rev',
      tokenStart: 7,
      tokenEnd: 11,
    });
  });

  test('does not open a skill when the slash is mid-word', () => {
    expect(resolveComposerAutocompleteTrigger({ text: 'http://x', cursor: 8 })).toBeNull();
  });

  test('opens a snippet trigger on a word-boundary hash', () => {
    expect(resolveComposerAutocompleteTrigger({ text: 'see #foo', cursor: 8 })).toEqual({
      kind: 'snippet',
      query: 'foo',
      tokenStart: 4,
      tokenEnd: 8,
    });
  });

  test('opens an @ mention on a word boundary', () => {
    expect(resolveComposerAutocompleteTrigger({ text: 'hi @src', cursor: 7 })).toEqual({
      kind: 'mention',
      query: 'src',
      tokenStart: 3,
      tokenEnd: 7,
    });
  });

  test('suppresses mention autocomplete when paste inserted an @', () => {
    expect(resolveComposerAutocompleteTrigger({
      text: 'see @src/a.ts',
      cursor: 13,
      mentionInputSource: 'paste',
      insertedText: '@src/a.ts',
    })).toBeNull();
  });
});
