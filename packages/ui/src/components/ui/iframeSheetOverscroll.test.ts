import { describe, expect, test } from 'vitest';

import {
  MOBILE_WINDOW_MOTION_ID_ATTR,
  findOwningMotionId,
  shouldHandIframePanToSheet,
} from './iframeSheetOverscroll';

describe('iframeSheetOverscroll', () => {
  test('hands a downward pan to the sheet only at the top of the document', () => {
    expect(shouldHandIframePanToSheet(0, 12)).toBe(true);
    expect(shouldHandIframePanToSheet(0.4, 8)).toBe(true);
    expect(shouldHandIframePanToSheet(2, 12)).toBe(false);
    expect(shouldHandIframePanToSheet(0, -8)).toBe(false);
    expect(shouldHandIframePanToSheet(0, 0)).toBe(false);
  });

  test('finds the owning sheet motion id from a nested iframe', () => {
    const sheet = document.createElement('div');
    sheet.setAttribute(MOBILE_WINDOW_MOTION_ID_ATTR, 'mobile-direct-file');
    const iframe = document.createElement('iframe');
    sheet.appendChild(iframe);
    document.body.appendChild(sheet);
    expect(findOwningMotionId(iframe)).toBe('mobile-direct-file');
    sheet.remove();
  });
});
