import { describe, expect, test } from 'bun:test';

import { resolveAssistantNestedOpenMode } from './assistantNestedSession';

describe('assistant nested session open mode', () => {
  test('opens the desktop context panel beside the assistant conversation', () => {
    expect(resolveAssistantNestedOpenMode({
      isPhoneShell: false,
      isMobile: false,
      isIPad: false,
      isVSCode: false,
    })).toBe('context-panel');
  });

  test('keeps iPad on the context panel instead of leaving the assistant workspace', () => {
    expect(resolveAssistantNestedOpenMode({
      isPhoneShell: false,
      isMobile: true,
      isIPad: true,
      isVSCode: false,
    })).toBe('context-panel');
  });

  test('redirects phone, mobile web, and VS Code into the subagent session', () => {
    expect(resolveAssistantNestedOpenMode({
      isPhoneShell: true,
      isMobile: true,
      isIPad: false,
      isVSCode: false,
    })).toBe('session');
    expect(resolveAssistantNestedOpenMode({
      isPhoneShell: false,
      isMobile: true,
      isIPad: false,
      isVSCode: false,
    })).toBe('session');
    expect(resolveAssistantNestedOpenMode({
      isPhoneShell: false,
      isMobile: false,
      isIPad: false,
      isVSCode: true,
    })).toBe('session');
  });
});
