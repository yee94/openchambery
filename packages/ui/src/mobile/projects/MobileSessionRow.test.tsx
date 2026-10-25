import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';

import {
  MobileSessionRow,
} from './MobileSessionRow';
import {
  resolveMobileSessionIndicator,
  type MobileSessionIndicator,
} from './mobileSessionIndicator';

const noop = () => undefined;
const mobileStyles = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../styles/mobile.css'),
  'utf8',
);

describe('Mobile project group chrome', () => {
  test('uses shared mobile border tokens with a quieter dark treatment', () => {
    expect(mobileStyles).toContain('--yuri-mobile-border: color-mix(');
    expect(mobileStyles).toContain('--yuri-mobile-divider: var(--yuri-mobile-border)');
    expect(mobileStyles).toContain('var(--surface-foreground) 3%');
    expect(mobileStyles).toContain('var(--surface-foreground) 2%');
    expect(mobileStyles).toContain('border: 1px solid var(--yuri-mobile-border)');
    expect(mobileStyles).toContain('box-shadow: inset 0 -1px 0 var(--yuri-mobile-divider)');
  });

  test('does not stack the label divider on a collapsed group border', () => {
    expect(mobileStyles).toContain('.yuri-mobile-labeled-surface-group-label:last-child');
    expect(mobileStyles).toContain('.yuri-mobile-labeled-surface-group-label:last-child {\n  box-shadow: none;');
  });

  test('uses momentary :active press fill instead of a persisted selected background', () => {
    const transparentIndex = mobileStyles.indexOf('.yuri-mobile-session-row-content,\n.yuri-mobile-session-pagination-row {');
    const pressIndex = mobileStyles.indexOf('.yuri-mobile-session-row-content:has(.yuri-mobile-session-row-main:active):not([data-dragging="true"])');
    const paginationPressIndex = mobileStyles.indexOf('.yuri-mobile-session-pagination-row:active');

    expect(transparentIndex).toBeGreaterThan(-1);
    expect(pressIndex).toBeGreaterThan(transparentIndex);
    expect(paginationPressIndex).toBeGreaterThan(pressIndex);
    expect(mobileStyles).not.toContain('.yuri-mobile-session-row-content[data-active="true"]');
    expect(mobileStyles).not.toContain('.yuri-mobile-session-row-content[data-pressed="true"]');
    expect(mobileStyles.slice(pressIndex)).toContain('background: var(--yuri-mobile-press-fill)');
    expect(mobileStyles).toContain('--yuri-mobile-press-fill: color-mix(');
    expect(mobileStyles).toContain('var(--surface-foreground) 7%');
    expect(mobileStyles).toContain('var(--surface-foreground) 10%');
    expect(mobileStyles).toContain('.yuri-mobile-project-card:has([data-mobile-press-surface-trigger]:active)');
    expect(mobileStyles).toContain('.yuri-mobile-project-card[data-pressed="true"]');
    expect(mobileStyles).not.toContain(
      '.yuri-mobile-session-row-content:has(.yuri-mobile-session-row-main:active):not([data-dragging="true"]),\n.yuri-mobile-session-pagination-row:active {\n  background: var(--interactive-hover);',
    );
  });

  test('project cards share the faint press fill instead of interactive-hover', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'MobileProjectCard.tsx'),
      'utf8',
    );
    expect(source).toContain('data-pressed={pressed ? \'true\' : undefined}');
    expect(source).not.toContain('bg-interactive-hover');
  });

  test('clips first, last, and single session rows to the group corners', () => {
    const rowBlock = mobileStyles.match(/\.yuri-mobile-session-row\s*\{[^}]*\}/s)?.[0] ?? '';
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'MobileSessionRow.tsx'),
      'utf8',
    );

    expect(rowBlock).toContain('--yuri-mobile-session-radius-start-start: 0');
    expect(rowBlock).toContain('--yuri-mobile-session-radius-start-end: 0');
    expect(rowBlock).toContain('--yuri-mobile-session-radius-end-end: 0');
    expect(rowBlock).toContain('--yuri-mobile-session-radius-end-start: 0');
    expect(mobileStyles).toMatch(
      /\.yuri-mobile-session-row\s*\{[^}]*overflow:\s*hidden;[^}]*border-start-start-radius:\s*var\(--yuri-mobile-session-radius-start-start\);[^}]*border-end-start-radius:\s*var\(--yuri-mobile-session-radius-end-start\);/s,
    );
    expect(mobileStyles).toMatch(
      /\.yuri-mobile-labeled-surface-group\s*>\s*\.yuri-mobile-session-row:first-child\s*\{[^}]*--yuri-mobile-session-radius-start-start:\s*calc\([^)]*var\(--yuri-mobile-inset-radius\)\s*-\s*1px[^)]*\);[^}]*--yuri-mobile-session-radius-start-end:/s,
    );
    expect(mobileStyles).toMatch(
      /\.yuri-mobile-labeled-surface-group\s*>\s*\.yuri-mobile-session-row:last-child,\s*\.yuri-mobile-labeled-surface-group-content\s*>\s*\.yuri-mobile-session-row:last-child\s*\{[^}]*--yuri-mobile-session-radius-end-end:[^}]*--yuri-mobile-session-radius-end-start:/s,
    );
    expect(source).toContain("cn('yuri-mobile-session-row relative isolate', className)");
    expect(source).not.toContain("cn('yuri-mobile-session-row relative isolate overflow-hidden', className)");
  });

  test('clips labeled group headers when they are the first or only item', () => {
    expect(mobileStyles).toMatch(
      /\.yuri-mobile-labeled-surface-group-label:first-child\s*\{[^}]*overflow:\s*hidden;[^}]*border-start-start-radius:\s*calc\(var\(--yuri-mobile-inset-radius\)\s*-\s*1px\);[^}]*border-start-end-radius:/s,
    );
    expect(mobileStyles).toMatch(
      /\.yuri-mobile-labeled-surface-group-label:last-child\s*\{[^}]*border-end-end-radius:\s*calc\(var\(--yuri-mobile-inset-radius\)\s*-\s*1px\);[^}]*border-end-start-radius:/s,
    );
  });

  test('uses the same edge radii for press fills and the revealed action rail', () => {
    expect(mobileStyles).toMatch(
      /\.yuri-mobile-session-row-content,\s*\.yuri-mobile-session-pagination-row\s*\{[^}]*border-start-start-radius:\s*var\(--yuri-mobile-session-radius-start-start\);[^}]*border-end-start-radius:\s*var\(--yuri-mobile-session-radius-end-start\);/s,
    );
    expect(mobileStyles).toMatch(
      /\.yuri-mobile-session-actions\s*\{[^}]*overflow:\s*hidden;[^}]*border-start-end-radius:\s*var\(--yuri-mobile-session-radius-start-end\);[^}]*border-end-end-radius:\s*var\(--yuri-mobile-session-radius-end-end\);/s,
    );
  });
});

describe('resolveMobileSessionIndicator', () => {
  const resolve = (overrides: Partial<{
    hasPendingQuestion: boolean;
    hasPendingPermission: boolean;
    running: boolean;
    unread: boolean;
  }> = {}): MobileSessionIndicator => resolveMobileSessionIndicator({
    hasPendingQuestion: false,
    hasPendingPermission: false,
    running: false,
    unread: false,
    ...overrides,
  });

  test('prioritizes blocking input over running and unread states', () => {
    expect(resolve({
      hasPendingQuestion: true,
      hasPendingPermission: true,
      running: true,
      unread: true,
    })).toBe('question');
    expect(resolve({
      hasPendingPermission: true,
      running: true,
      unread: true,
    })).toBe('permission');
  });

  test('uses running, completed-unread, then idle as fallbacks', () => {
    expect(resolve({ running: true, unread: true })).toBe('running');
    expect(resolve({ unread: true })).toBe('completed-unread');
    expect(resolve()).toBe('idle');
  });
});

describe('MobileSessionRow memo contract', () => {
  test('MobileSessionRow uses default React.memo (no custom comparer)', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'MobileSessionRow.tsx'),
      'utf8',
    );
    expect(source).toContain('export const MobileSessionRow = React.memo(MobileSessionRowImpl)');
    expect(source).not.toContain('areMobileSessionRowPropsEqual');
  });
});

describe('MobileSessionRow status placement', () => {
  test('does not persist selected or JS pressed backgrounds on the row', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'MobileSessionRow.tsx'),
      'utf8',
    );
    expect(source).not.toContain('data-active=');
    expect(source).not.toContain('data-pressed=');
    expect(source).toContain('data-dragging={dragging ? \'true\' : undefined}');
    expect(source).toContain('yuri-mobile-session-pagination-row');
  });

  test('renders the running indicator in the leading status slot', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileSessionRow
          session={{ id: 'session-1', title: 'Running session' }}
          indicator="running"
          onSelect={noop}
          onPin={noop}
          onArchive={noop}
          onOpenActions={noop}
        />
      </I18nProvider>,
    );

    const statusIndex = html.indexOf('data-session-status="running"');
    const titleIndex = html.indexOf('Running session');
    const timeColumnIndex = html.indexOf('flex shrink-0 items-center gap-1.5 text-muted-foreground');
    expect(statusIndex).toBeGreaterThan(-1);
    expect(statusIndex).toBeLessThan(titleIndex);
    expect(html.slice(timeColumnIndex)).not.toContain('animate-spin');
  });

  test('does not render a subsession chevron without expand props', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileSessionRow
          session={{ id: 'parent', title: 'Parent session' }}
          onSelect={noop}
          onPin={noop}
          onArchive={noop}
          onOpenActions={noop}
        />
      </I18nProvider>,
    );
    expect(html).not.toContain('Expand subsessions');
    expect(html).not.toContain('Collapse subsessions');
    expect(html).not.toContain('#yuri-arrow-down-s');
  });

  test('shows session change counts next to the title when provided', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileSessionRow
          session={{ id: 'session-1', title: 'Login', changes: '+12 −3' }}
          onSelect={noop}
          onPin={noop}
          onArchive={noop}
          onOpenActions={noop}
        />
      </I18nProvider>,
    );
    expect(html).toContain('yuri-mobile-session-changes');
    expect(html).toContain('+12 −3');
    expect(html.indexOf('Login')).toBeLessThan(html.indexOf('+12 −3'));
  });

  test('wraps keyword matches in mark when highlightQuery is set', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileSessionRow
          session={{ id: 'session-1', title: 'Fix mobile search', subtitle: 'Follow-up search' }}
          highlightQuery="search"
          onSelect={noop}
          onPin={noop}
          onArchive={noop}
          onOpenActions={noop}
        />
      </I18nProvider>,
    );

    expect(html).toContain('<mark');
    expect(html).toContain('bg-transparent font-[inherit] text-[var(--primary-base)]');
    expect(html.match(/<mark/g)?.length).toBe(2);
  });

  test('renders distinct question, permission, unread, and idle markers', () => {
    const rendered = new Map<string, string>();
    for (const indicator of ['question', 'permission', 'completed-unread', 'idle'] as const) {
      const html = renderToString(
        <I18nProvider>
          <MobileSessionRow
            session={{ id: `session-${indicator}`, title: indicator, unread: indicator === 'completed-unread' }}
            indicator={indicator}
            onSelect={noop}
            onPin={noop}
            onArchive={noop}
            onOpenActions={noop}
          />
        </I18nProvider>,
      );
      expect(html).toContain(`data-session-status="${indicator}"`);
      rendered.set(indicator, html);
    }
    expect(rendered.get('completed-unread')).toContain('bg-[var(--status-info)]');
    expect(rendered.get('idle')).toContain('bg-muted-foreground/35');
  });
});
