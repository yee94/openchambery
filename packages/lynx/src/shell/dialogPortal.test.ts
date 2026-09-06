import { describe, expect, test } from 'vitest';

import {
  LYNX_SHELL_DIALOG_PORTAL,
  LYNX_SHELL_DIALOG_PORTAL_NOTES,
} from './dialogPortal';

describe('Lynx shell dialog portal (Cap DialogPortal spirit)', () => {
  test('mounts at shell root as full-screen overlay, not nested sheet relative', () => {
    expect(LYNX_SHELL_DIALOG_PORTAL.mountPoint).toBe('shell-root');
    expect(LYNX_SHELL_DIALOG_PORTAL.placement).toBe('full-screen-overlay');
    expect(LYNX_SHELL_DIALOG_PORTAL.nestedInRelativeSheet).toBe(false);
    expect(LYNX_SHELL_DIALOG_PORTAL.zIndex).toBe(50);
  });

  test('notes call out shell host vs Changes relative nest', () => {
    const joined = LYNX_SHELL_DIALOG_PORTAL_NOTES.join(' ');
    expect(joined).toMatch(/shell/i);
    expect(joined).toMatch(/full-screen/i);
    expect(joined).toMatch(/not nest/i);
    expect(joined).toMatch(/Changes/i);
    expect(joined).toMatch(/NOT DONE/);
  });
});
