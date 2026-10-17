import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderResult, UsageWindow } from '@/types';

const state = vi.hoisted(() => ({ results: [] as ProviderResult[], selectedProviderId: 'magpie:gateway:claude',
  selectedModels: {}, dropdownProviderIds: ['magpie:gateway:claude'], expandedFamilies: {}, displayMode: 'usage', showPredValues: true,
  setSelectedProvider: () => {}, loadSettings: async () => {}, fetchAllQuotas: async () => {}, applyDefaultSelections: () => {},
}));
vi.mock('@/stores/useQuotaStore', () => ({ useQuotaStore: (select: (s: typeof state) => unknown) => select(state), useQuotaAutoRefresh: () => {} }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (s: { timeFormatPreference: string }) => unknown) => select({ timeFormatPreference: '24h' }) }));
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: async () => {} }));
vi.mock('@/lib/i18n', () => ({ getCurrentIntlLocale: () => 'en-US', useI18n: () => ({ locale: 'en', t: (key: string, values?: Record<string, unknown>) => values?.provider ?? key }) }));
vi.mock('@/components/ui/ProviderLogo', () => ({ ProviderLogo: () => null }));
vi.mock('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
import { UsagePage } from './UsagePage';

describe('Magpie account quota rendering', () => {
  it('renders distinct accounts, every window, reset time, balance and cached errors without model-family heuristics', () => {
    const window: UsageWindow = { usedPercent: 20, remainingPercent: 80, resetAt: Date.parse('2026-10-19T12:34:00Z'),
      resetAfterSeconds: null, resetAtFormatted: null, resetAfterFormatted: null, windowSeconds: null, disablePace: true, valueLabel: '20 / 100', label: 'daily' };
    state.results = [{ providerId: 'magpie:gateway:claude', providerName: 'Claude · Magpie', source: 'magpie', sourceId: 'gateway',
      ok: false, configured: true, fetchedAt: 1, usage: { windows: { flattened: window }, accounts: [
        { id: 'a', name: 'Account A', user: '', plan: 'Pro', kind: 'subscription', from: '', balance: '', readAt: 1, stale: false, windows: { daily: window, weekly: { ...window, label: 'weekly', usedPercent: 70, valueLabel: null } } },
        { id: 'b', name: 'Account B', user: '', plan: '', kind: 'balance', from: '', balance: '$12', readAt: 1, stale: true, error: 'unavailable', windows: { balance: { ...window, label: 'credits_balance', usedPercent: null, remainingPercent: null, resetAt: null, valueLabel: '$12' } } },
      ] } }];
    const html = renderToStaticMarkup(<UsagePage />);
    expect(html).toContain('Claude · Magpie');
    expect(html).toContain('Account A'); expect(html).toContain('Account B');
    expect(html).toContain('20% · 20 / 100'); expect(html).toContain('70%'); expect(html).toContain('$12');
    expect(html).toContain('settings.usage.magpie.cached');
    expect(html).toContain('settings.usage.page.state.refreshFailedTitle');
    expect(html).not.toContain('flattened');
    expect(html.match(/role="progressbar"/g)).toHaveLength(2);
    expect(html).not.toContain('Expected usage');
    expect(html).toContain(':34');
    expect(html).toContain('minutes');
  });
});
