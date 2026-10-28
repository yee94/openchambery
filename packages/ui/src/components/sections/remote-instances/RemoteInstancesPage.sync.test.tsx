import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useEvent } from '@reactuses/core';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

it('keeps scope and preview mounted, coalesces pending selections and applies only the latest review', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'RemoteInstancesPage.tsx'), 'utf8');
  const scope: Record<string, unknown> = { React, useEvent,
    useI18n: () => ({ t: (key: string) => key }), cn: (...values: string[]) => values.filter(Boolean).join(' '),
    toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
    buildDefaultSyncSelections: () => ({ fileGroups: [true], singleFiles: [], directories: [], agentsRoot: true, providerCredentials: false }),
    Icon: () => null,
    Checkbox: ({ checked, onChange, ariaLabel, disabled }: { checked: boolean; onChange: (value: boolean) => void; ariaLabel: string; disabled: boolean }) =>
      <input type="checkbox" aria-label={ariaLabel} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />,
    Button: ({ children, onClick, disabled }: React.ComponentProps<'button'>) => <button disabled={disabled} onClick={onClick}>{children}</button>,
  };
  for (const name of ['Dialog', 'DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription', 'DialogFooter', 'ScrollableOverlay']) {
    scope[name] = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  }
  const plan = { files: [{ path: 'opencode.json', bytes: 10 }], directories: [], deletes: [], agentsRoot: null,
    providerCredentials: null, magpie: null, magpieAvailable: true, selectionShape: { fileGroups: 1, singleFiles: 0, directories: 0 } };
  const response = { plan, remoteExisting: [] };
  const pending: Array<(value: typeof response) => void> = [];
  const preview = vi.fn().mockResolvedValueOnce(response).mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  const apply = vi.fn().mockResolvedValue({});
  scope.desktopSshSyncOpencodeConfigLocalScan = vi.fn().mockResolvedValue(plan);
  scope.desktopSshSyncOpencodeConfigPreview = preview;
  scope.desktopSshSyncOpencodeConfigApply = apply;
  const compiled = ts.transpileModule(source.slice(source.indexOf('const formatSyncBytes'), source.indexOf('type PairingTransportOptions')), {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const Surface = new Function(...Object.keys(scope), `${compiled}; return SyncConfigDialog;`)(...Object.values(scope));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Surface open instanceId="fixture" onOpenChange={() => {}} />));
    const checkbox = host.querySelector('input')!;
    const magpie = host.querySelector('input[aria-label$="section.magpie"]');
    const row = host.querySelector('[title="opencode.json"]')!;
    const sync = [...host.querySelectorAll('button')].find((node) => node.textContent?.endsWith('syncNow'))!;
    await act(async () => checkbox.click());
    expect(sync.disabled).toBe(true);
    expect(row.isConnected).toBe(true);
    expect(host.querySelector('input[aria-label$="section.magpie"]')).toBe(magpie);
    for (let index = 0; index < 50; index++) {
      await act(async () => checkbox.click());
      expect(row.isConnected).toBe(true);
      expect(host.querySelector('input[aria-label$="section.magpie"]')).toBe(magpie);
    }
    expect(preview).toHaveBeenCalledTimes(2);
    await act(async () => pending.shift()!(response));
    expect(preview).toHaveBeenCalledTimes(3);
    expect(sync.disabled).toBe(true);
    await act(async () => pending.shift()!(response));
    expect(sync.disabled).toBe(false);
    await act(async () => sync.click());
    expect(apply.mock.calls[0][1].selections.fileGroups).toEqual([false]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
