import { describe, expect, test } from 'bun:test';

import { createMentionTouchSelectionController } from './fileMentionTouchSelection';

describe('FileMentionAutocomplete touch selection', () => {
  test('selects on pointer-up and consumes the following click', () => {
    const controller = createMentionTouchSelectionController();
    let selections = 0;
    const select = () => { selections += 1; };

    controller.pointerDown(20, 30);
    expect(controller.pointerUp(select)).toBe(true);
    expect(controller.click(select)).toBe(false);
    expect(selections).toBe(1);
  });

  test('treats movement beyond the threshold as scrolling', () => {
    const controller = createMentionTouchSelectionController();
    let selections = 0;

    controller.pointerDown(20, 30);
    controller.pointerMove(20, 40);

    expect(controller.pointerUp(() => { selections += 1; })).toBe(false);
    expect(controller.click(() => { selections += 1; })).toBe(false);
    expect(selections).toBe(0);
  });

  test('clears a cancelled touch without selecting', () => {
    const controller = createMentionTouchSelectionController();
    let selections = 0;

    controller.pointerDown(20, 30);
    controller.pointerCancel();

    expect(controller.pointerUp(() => { selections += 1; })).toBe(false);
    expect(selections).toBe(0);
  });
});
