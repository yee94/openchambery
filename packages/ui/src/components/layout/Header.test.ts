import { describe, expect, test } from 'vitest';

import { resolveServicesPanelIntent } from './servicesPanelIntent';

describe('resolveServicesPanelIntent', () => {
  test('opens onto the target tab when the panel is closed', () => {
    expect(
      resolveServicesPanelIntent({
        isOpen: false,
        activeTab: 'mcp',
        targetTab: 'instance',
      }),
    ).toEqual({ open: true, tab: 'instance' });

    expect(
      resolveServicesPanelIntent({
        isOpen: false,
        activeTab: 'instance',
        targetTab: 'usage',
      }),
    ).toEqual({ open: true, tab: 'usage' });
  });

  test('switches tab and stays open when already open on a different tab', () => {
    expect(
      resolveServicesPanelIntent({
        isOpen: true,
        activeTab: 'usage',
        targetTab: 'instance',
      }),
    ).toEqual({ open: true, tab: 'instance' });

    expect(
      resolveServicesPanelIntent({
        isOpen: true,
        activeTab: 'mcp',
        targetTab: 'usage',
      }),
    ).toEqual({ open: true, tab: 'usage' });

    expect(
      resolveServicesPanelIntent({
        isOpen: true,
        activeTab: 'instance',
        targetTab: 'usage',
      }),
    ).toEqual({ open: true, tab: 'usage' });
  });

  test('closes when already open on the target tab', () => {
    expect(
      resolveServicesPanelIntent({
        isOpen: true,
        activeTab: 'instance',
        targetTab: 'instance',
      }),
    ).toEqual({ open: false, tab: 'instance' });

    expect(
      resolveServicesPanelIntent({
        isOpen: true,
        activeTab: 'usage',
        targetTab: 'usage',
      }),
    ).toEqual({ open: false, tab: 'usage' });
  });

  test('non-desktop usage target opens or toggles usage without requiring instance', () => {
    expect(
      resolveServicesPanelIntent({
        isOpen: false,
        activeTab: 'usage',
        targetTab: 'usage',
      }),
    ).toEqual({ open: true, tab: 'usage' });

    expect(
      resolveServicesPanelIntent({
        isOpen: true,
        activeTab: 'mcp',
        targetTab: 'usage',
      }),
    ).toEqual({ open: true, tab: 'usage' });

    expect(
      resolveServicesPanelIntent({
        isOpen: true,
        activeTab: 'usage',
        targetTab: 'usage',
      }),
    ).toEqual({ open: false, tab: 'usage' });
  });
});
