import { describe, expect, test } from 'vitest';
import { isAssistantWorking } from './assistantWorking';

describe('isAssistantWorking', () => {
  test('is on only while a contact turn is sending or processing', () => {
    expect(isAssistantWorking({ sending: true })).toBe(true);
    expect(isAssistantWorking({ processing: true })).toBe(true);
    expect(isAssistantWorking({})).toBe(false);
  });
});
