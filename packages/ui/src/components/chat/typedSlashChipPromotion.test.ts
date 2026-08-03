import { describe, expect, test } from 'bun:test';
import { COMPOSER_TRIGGER_ICON_SLOT } from '@/composer/inline-visual';
import {
  findTypedSlashChipTokens,
  promoteTypedSlashChipSlots,
  stripLeadingSlashCommandSlot,
} from './typedSlashChipPromotion';

const known = new Set(['undo', 'redo', 'compact', 'loop', 'review-pr']);

describe('typedSlashChipPromotion', () => {
  test('finds complete known slash tokens and ignores partials', () => {
    expect(findTypedSlashChipTokens('/und', known)).toEqual([]);
    expect(findTypedSlashChipTokens('/undo', known)).toEqual([
      { start: 0, end: 5, name: 'undo', hasSlot: false },
    ]);
    expect(findTypedSlashChipTokens(`please /undo now`, known)).toEqual([
      { start: 7, end: 12, name: 'undo', hasSlot: false },
    ]);
  });

  test('accepts reserved-slot chips without promoting them again', () => {
    const reserved = `/${COMPOSER_TRIGGER_ICON_SLOT}undo`;
    expect(findTypedSlashChipTokens(reserved, known)).toEqual([
      { start: 0, end: reserved.length, name: 'undo', hasSlot: true },
    ]);
    expect(promoteTypedSlashChipSlots(reserved, known, reserved.length)).toBeNull();
  });

  test('promotes compact hand-typed chips and adjusts the caret', () => {
    expect(promoteTypedSlashChipSlots('/undo', known, 5)).toEqual({
      text: `/${COMPOSER_TRIGGER_ICON_SLOT}undo`,
      caret: 6,
    });
    expect(promoteTypedSlashChipSlots('go /loop please', known, 8)).toEqual({
      text: `go /${COMPOSER_TRIGGER_ICON_SLOT}loop please`,
      caret: 9,
    });
  });

  test('promotes multiple compact chips right-to-left', () => {
    expect(promoteTypedSlashChipSlots('/undo /redo', known, 11)).toEqual({
      text: `/${COMPOSER_TRIGGER_ICON_SLOT}undo /${COMPOSER_TRIGGER_ICON_SLOT}redo`,
      caret: 13,
    });
  });

  test('strips a leading reserved slot from autocomplete query bodies', () => {
    expect(stripLeadingSlashCommandSlot(`${COMPOSER_TRIGGER_ICON_SLOT}undo`)).toBe('undo');
    expect(stripLeadingSlashCommandSlot('undo')).toBe('undo');
  });
});
