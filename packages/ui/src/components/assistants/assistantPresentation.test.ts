import { describe, expect, test } from 'bun:test';
import { getAssistantPresentation } from './assistantPresentation';

describe('getAssistantPresentation', () => {
  test('keeps a regular assistant name unchanged', () => {
    expect(getAssistantPresentation('Code Helper')).toEqual({ displayName: 'Code Helper' });
  });

  test('uses the leading emoji as the avatar and removes it from the display name', () => {
    expect(getAssistantPresentation('🤖 Code Helper')).toEqual({ avatarEmoji: '🤖', displayName: 'Code Helper' });
  });

  test('keeps compound emoji together', () => {
    expect(getAssistantPresentation('👩🏽‍💻 Developer')).toEqual({ avatarEmoji: '👩🏽‍💻', displayName: 'Developer' });
    expect(getAssistantPresentation('🇨🇳 Translator')).toEqual({ avatarEmoji: '🇨🇳', displayName: 'Translator' });
  });

  test('removes an emoji-only name from the display label', () => {
    expect(getAssistantPresentation('🌟')).toEqual({ avatarEmoji: '🌟', displayName: '' });
  });

  test('leaves emoji outside the first grapheme in the display name', () => {
    expect(getAssistantPresentation('Code 🤖 Helper')).toEqual({ displayName: 'Code 🤖 Helper' });
  });
});
