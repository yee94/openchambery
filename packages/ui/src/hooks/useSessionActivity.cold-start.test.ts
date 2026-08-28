import { describe, expect, test } from 'vitest';

import { resolvePendingAssistantWorkingFallback } from './useSessionActivity';

describe('resolvePendingAssistantWorkingFallback', () => {
  test('cold-start assemble (no completed assistant) disables pending-assistant fallback', () => {
    // Empty → slim → streaming: last assistant has no completed yet and no
    // earlier completed assistant exists. Fallback must not invent isWorking.
    expect(resolvePendingAssistantWorkingFallback({
      messages: [
        { role: 'user', time: { created: 1 } },
        { role: 'assistant', time: { created: 2 } },
      ],
      hasPendingAssistant: true,
    })).toBe(false);

    expect(resolvePendingAssistantWorkingFallback({
      messages: [],
      hasPendingAssistant: false,
    })).toBe(false);
  });

  test('warm transcript with a completed assistant allows pending-assistant fallback', () => {
    expect(resolvePendingAssistantWorkingFallback({
      messages: [
        { role: 'assistant', time: { created: 1, completed: 2 } },
        { role: 'user', time: { created: 3 } },
        { role: 'assistant', time: { created: 4 } },
      ],
      hasPendingAssistant: true,
    })).toBe(true);
  });

  test('no pending assistant → fallback false even when completed assistants exist', () => {
    expect(resolvePendingAssistantWorkingFallback({
      messages: [
        { role: 'assistant', time: { created: 1, completed: 2 } },
      ],
      hasPendingAssistant: false,
    })).toBe(false);
  });
});
