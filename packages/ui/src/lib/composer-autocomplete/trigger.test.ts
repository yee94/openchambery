import { describe, expect, test } from 'vitest';

import { COMPOSER_TRIGGER_ICON_SLOT } from '@/composer/inline-visual';

import { insertTokenWithReferenceBoundaries } from '@/components/chat/insertionBoundaries';

import { resolveComposerAutocompleteReplaceRange, resolveComposerAutocompleteTrigger } from './trigger';

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

  test('accepting a mention replaces the open @ token even when the caret is stale', () => {
    const text = 'see @src';
    const trigger = resolveComposerAutocompleteTrigger({ text, cursor: 8 });
    expect(resolveComposerAutocompleteReplaceRange(text, 0, trigger)).toEqual({
      start: 4,
      end: 8,
    });
    expect(insertTokenWithReferenceBoundaries(text, 4, 8, '@src/foo.ts')).toEqual({
      text: 'see @src/foo.ts ',
      caret: 16,
      start: 4,
      end: 15,
    });
    expect(resolveComposerAutocompleteTrigger({
      text: 'see @src/foo.ts ',
      cursor: 16,
    })).toBeNull();
  });

  test('accepting a slash token uses the open trigger, not caret 0', () => {
    const text = '/un';
    const trigger = resolveComposerAutocompleteTrigger({ text, cursor: 3 });
    expect(resolveComposerAutocompleteReplaceRange(text, 0, trigger)).toEqual({
      start: 0,
      end: 3,
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
