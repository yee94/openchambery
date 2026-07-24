import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToString } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';

import { MobileSessionRow } from './MobileSessionRow';
import {
  resolveMobileSessionIndicator,
  type MobileSessionIndicator,
} from './mobileSessionIndicator';

const noop = () => undefined;

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

describe('MobileSessionRow status placement', () => {
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
