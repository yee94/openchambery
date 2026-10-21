import { describe, expect, test } from 'vitest';
import { getAssistantPresentation } from './assistantPresentation';

describe('getAssistantPresentation', () => {
  test('keeps a regular assistant name unchanged', () => {
    expect(getAssistantPresentation('Code Helper')).toEqual({ displayName: 'Code Helper' });
  });

  test('preserves leading emoji as part of the name instead of extracting an avatar', () => {
    expect(getAssistantPresentation('🤖 Code Helper')).toEqual({ displayName: '🤖 Code Helper' });
  });

  test('keeps compound emoji together', () => {
    expect(getAssistantPresentation('👩🏽‍💻 Developer')).toEqual({ displayName: '👩🏽‍💻 Developer' });
    expect(getAssistantPresentation('🇨🇳 Translator')).toEqual({ displayName: '🇨🇳 Translator' });
  });

  test('keeps an emoji-only name visible', () => {
    expect(getAssistantPresentation('🌟')).toEqual({ displayName: '🌟' });
  });

  test('leaves emoji outside the first grapheme in the display name', () => {
    expect(getAssistantPresentation('Code 🤖 Helper')).toEqual({ displayName: 'Code 🤖 Helper' });
  });
});
