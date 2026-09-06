import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';

import {
  MobileSessionRow,
  type MobileSessionRowModel,
} from './MobileSessionRow';

const noop = () => undefined;

const session = (id: string): MobileSessionRowModel => ({
  id,
  title: `Session ${id}`,
});

describe('MobileSessionRow default React.memo behavior', () => {
  test('stable session identity keeps painted title across parent-only bumps', () => {
    function Host({
      bump,
      sessionModel,
      onSelect,
    }: {
      bump: number;
      sessionModel: MobileSessionRowModel;
      onSelect: (session: MobileSessionRowModel) => void;
    }) {
      void bump;
      return (
        <I18nProvider>
          <MobileSessionRow
            session={sessionModel}
            onSelect={onSelect}
            onPin={noop}
            onArchive={noop}
            onOpenActions={noop}
          />
        </I18nProvider>
      );
    }

    const model = session('stable');
    const onSelect = noop;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    act(() => {
      root.render(<Host bump={0} sessionModel={model} onSelect={onSelect} />);
    });
    expect(container.textContent).toContain('Session stable');

    act(() => {
      root.render(<Host bump={1} sessionModel={model} onSelect={onSelect} />);
    });
    expect(container.textContent).toContain('Session stable');

    const nextModel = session('changed');
    act(() => {
      root.render(<Host bump={2} sessionModel={nextModel} onSelect={onSelect} />);
    });
    expect(container.textContent).toContain('Session changed');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  test('parent re-render with stable session refs does not re-render unrelated memo rows', () => {
    const renderCounts = new Map<string, number>();

    const CountingRow = React.memo(function CountingRow(props: {
      session: MobileSessionRowModel;
      onSelect: (session: MobileSessionRowModel) => void;
    }) {
      renderCounts.set(props.session.id, (renderCounts.get(props.session.id) ?? 0) + 1);
      return (
        <MobileSessionRow
          session={props.session}
          onSelect={props.onSelect}
          onPin={noop}
          onArchive={noop}
          onOpenActions={noop}
        />
      );
    });

    const sessions = Array.from({ length: 40 }, (_, index) => session(`s${index}`));
    const onSelect = noop;

    function Host({ bump }: { bump: number }) {
      void bump;
      return (
        <I18nProvider>
          <div>
            {sessions.map((entry) => (
              <CountingRow key={entry.id} session={entry} onSelect={onSelect} />
            ))}
          </div>
        </I18nProvider>
      );
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    act(() => {
      root.render(<Host bump={0} />);
    });
    const afterMount = sessions.reduce(
      (sum, entry) => sum + (renderCounts.get(entry.id) ?? 0),
      0,
    );
    expect(afterMount).toBe(40);

    act(() => {
      root.render(<Host bump={1} />);
    });
    const afterParentRerender = sessions.reduce(
      (sum, entry) => sum + (renderCounts.get(entry.id) ?? 0),
      0,
    );
    expect(afterParentRerender).toBe(40);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  test('MobileSessionRow uses default React.memo without a custom comparer export', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'MobileSessionRow.tsx'),
      'utf8',
    );
    expect(source).toContain('export const MobileSessionRow = React.memo(MobileSessionRowImpl)');
    expect(source).not.toContain('areMobileSessionRowPropsEqual');
  });
});
