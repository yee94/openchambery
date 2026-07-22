import { describe, expect, it } from 'bun:test';
import { validAssistantDeliveryParts } from './assistant-delivery-parts.js';

describe('validAssistantDeliveryParts', () => {
  it('accepts text parts with synthetic flags', () => {
    expect(validAssistantDeliveryParts([
      { type: 'text', text: 'hello' },
      { type: 'text', text: '<system-reminder>\nstyle\n</system-reminder>', synthetic: true },
    ])).toBe(true);
  });

  it('rejects text parts with unknown keys or non-boolean synthetic', () => {
    expect(validAssistantDeliveryParts([{ type: 'text', text: 'hello', id: 'part_1' }])).toBe(false);
    expect(validAssistantDeliveryParts([{ type: 'text', text: 'hello', synthetic: 'yes' }])).toBe(false);
  });
});
