import { describe, expect, test } from 'vitest';
import { isAssistantWorking } from './assistantWorking';

describe('isAssistantWorking', () => {
  test('is on for local sending/processing or server-authoritative working', () => {
    expect(isAssistantWorking({ sending: true })).toBe(true);
    expect(isAssistantWorking({ processing: true })).toBe(true);
    expect(isAssistantWorking({ serverWorking: true })).toBe(true);
    expect(isAssistantWorking({})).toBe(false);
    expect(isAssistantWorking({ sending: false, processing: false, serverWorking: false })).toBe(false);
  });
});
