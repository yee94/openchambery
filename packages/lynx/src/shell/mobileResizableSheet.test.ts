import { describe, expect, test } from 'vitest';

import {
  LYNX_MOBILE_RESIZABLE_SHEET,
  LYNX_MOBILE_SHEET_DISMISS_THRESHOLD_PX,
  LYNX_MOBILE_SHEET_HALF_HEIGHT_FRACTION,
  resolveLynxMobileSheetHeightPercent,
  shouldDismissLynxMobileSheetDrag,
  toggleLynxMobileSheetSnap,
} from './mobileResizableSheet';

describe('Lynx MobileResizableSheet spirit', () => {
  test('defaults to half-height bottom overlay with grabber + vertical dismiss', () => {
    expect(LYNX_MOBILE_RESIZABLE_SHEET.fullScreenOpaque).toBe(false);
    expect(LYNX_MOBILE_RESIZABLE_SHEET.halfHeightFraction).toBe(0.5);
    expect(LYNX_MOBILE_RESIZABLE_SHEET.grabber).toBe(true);
    expect(LYNX_MOBILE_RESIZABLE_SHEET.dismissVertical).toBe(true);
    expect(LYNX_MOBILE_RESIZABLE_SHEET.dismissOnScrim).toBe(true);
    expect(LYNX_MOBILE_RESIZABLE_SHEET.insideGlassContentView).toBe(false);
    expect(LYNX_MOBILE_RESIZABLE_SHEET.placement).toBe('bottom-overlay');
    expect(LYNX_MOBILE_SHEET_HALF_HEIGHT_FRACTION).toBe(0.5);
  });

  test('resolves height percents and toggles snap', () => {
    expect(resolveLynxMobileSheetHeightPercent('half')).toBe('50%');
    expect(resolveLynxMobileSheetHeightPercent('expanded')).toBe('92%');
    expect(toggleLynxMobileSheetSnap('half')).toBe('expanded');
    expect(toggleLynxMobileSheetSnap('expanded')).toBe('half');
  });

  test('vertical drag-down past Cap threshold dismisses', () => {
    expect(shouldDismissLynxMobileSheetDrag(LYNX_MOBILE_SHEET_DISMISS_THRESHOLD_PX)).toBe(true);
    expect(shouldDismissLynxMobileSheetDrag(LYNX_MOBILE_SHEET_DISMISS_THRESHOLD_PX - 1)).toBe(false);
    expect(shouldDismissLynxMobileSheetDrag(-20)).toBe(false);
  });
});
