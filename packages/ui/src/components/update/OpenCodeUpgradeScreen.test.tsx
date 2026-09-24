import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { dict as en } from '@/lib/i18n/messages/en';
import { parseUpgradeScreenStatus } from '@/lib/opencode/upgrade-screen';
import { OpenCodeUpgradeScreen } from './OpenCodeUpgradeScreen';

const fixture = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({
    t: (key: keyof typeof en, params?: Record<string, string>) => {
      let text: string = en[key] ?? key;
      for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, value);
      return text;
    },
  }),
}));
vi.mock('@/lib/runtime-fetch', () => ({
  runtimeFetch: (...args: unknown[]) => fixture.fetch(...args),
}));
vi.mock('@/lib/runtime-switch', () => ({
  subscribeRuntimeEndpointChanged: () => () => {},
}));
vi.mock('@/components/ui/OpenChamberLogo', () => ({
  OpenChamberLogo: () => <div data-logo="true" />,
}));
vi.mock('@/components/desktop/DesktopHostSwitcher', () => ({
  DesktopHostSwitcherInline: () => <div data-host-switcher="true" />,
}));
vi.mock('@/components/icon/Icon', () => ({
  Icon: () => null,
}));

const status = (patch: Record<string, unknown>) => ({
  state: 'incompatible',
  version: '2.0.14',
  installation: 'managed',
  minimumVersion: '2.0.15',
  targetVersion: '2.0.15',
  canInstall: true,
  guidance: null,
  ...patch,
});

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.fetch.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

describe('parseUpgradeScreenStatus', () => {
  test('rejects a payload that could be mistaken for a successful upgrade', () => {
    expect(parseUpgradeScreenStatus(status({ state: 'compatible', version: '2.0.15', canInstall: false })).state).toBe('compatible');
    expect(() => parseUpgradeScreenStatus({ upgraded: true })).toThrow(/compatibility/);
  });
});

describe('OpenCodeUpgradeScreen', () => {
  test('shows the gate below 2.0.15 and stays off it at 2.0.15', async () => {
    fixture.fetch.mockResolvedValue(Response.json(status({})));
    await act(async () => {
      root.render(<OpenCodeUpgradeScreen><div data-app="true">app</div></OpenCodeUpgradeScreen>);
    });
    expect(host.querySelector('[data-opencode-upgrade-screen]')).not.toBeNull();
    expect(host.textContent).toContain('OpenCode 2.0.14 is installed');
    expect(host.textContent).toContain('Update to OpenCode 2.0.15');
    expect(host.querySelector('[data-app]')).toBeNull();

    fixture.fetch.mockResolvedValue(Response.json(status({ state: 'compatible', version: '2.0.15', canInstall: false })));
    await act(async () => { root.unmount(); });
    host.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(<OpenCodeUpgradeScreen><div data-app="true">app</div></OpenCodeUpgradeScreen>);
    });
    expect(host.querySelector('[data-opencode-upgrade-screen]')).toBeNull();
    expect(host.querySelector('[data-app]')).not.toBeNull();
  });

  test('shows the install failure and does not enter the app', async () => {
    fixture.fetch.mockImplementation(async (path: string) => {
      if (String(path).includes('install-required')) {
        return Response.json({ success: false, upgraded: false, error: 'registry unreachable' }, { status: 500 });
      }
      return Response.json(status({}));
    });
    await act(async () => {
      root.render(<OpenCodeUpgradeScreen><div data-app="true">app</div></OpenCodeUpgradeScreen>);
    });
    const button = [...host.querySelectorAll('button')].find((node) => node.textContent?.includes('Update to OpenCode 2.0.15'));
    expect(button).toBeTruthy();
    await act(async () => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(host.textContent).toContain('OpenCode was not upgraded');
    expect(host.textContent).toContain('registry unreachable');
    expect(host.querySelector('[data-app]')).toBeNull();
    expect(host.textContent).not.toContain('Version 2.0.15 installed');
  });
});
