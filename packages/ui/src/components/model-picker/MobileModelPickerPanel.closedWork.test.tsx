import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { MobileModelPickerPanel } from './MobileModelPickerPanel';
import type { ModelPickerEntry, ModelPickerProvider } from './ModelPickerList';

const counters = vi.hoisted(() => ({
  formatTokensCalls: 0,
  mergeMetadataCalls: 0,
}));

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  getCurrentIntlLocale: () => 'en-US',
}));

vi.mock('@/lib/intlFormatters', async () => {
  const actual = await vi.importActual<typeof import('@/lib/intlFormatters')>('@/lib/intlFormatters');
  return {
    ...actual,
    formatCompactTokensShort: (value: number, locale?: string) => {
      counters.formatTokensCalls += 1;
      return actual.formatCompactTokensShort(value, locale);
    },
  };
});

vi.mock('@/lib/modelMetadata', () => ({
  mergeModelMetadataWithLiveModel: (
    _providerID: string,
    model: Record<string, unknown>,
    metadata?: { limit?: { context?: number } },
  ) => {
    counters.mergeMetadataCalls += 1;
    return {
      ...metadata,
      limit: {
        context: metadata?.limit?.context ?? (typeof model.context === 'number' ? model.context : 128_000),
      },
    };
  },
}));

vi.mock('@/lib/modelDisplay', () => ({
  getModelDisplayName: (_model: unknown, modelID: string) => modelID,
}));

vi.mock('@/lib/search/modelSearch', () => ({
  matchesModelSearch: () => true,
}));

vi.mock('@/components/icon/Icon', () => ({
  Icon: () => null,
}));

vi.mock('@/components/ui/ModelLogo', () => ({
  ModelLogo: () => null,
}));

vi.mock('@/components/ui/ProviderLogo', () => ({
  ProviderLogo: () => null,
}));

vi.mock('@/components/ui/ScrollableOverlay', () => ({
  ScrollableOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/ui/matchingPress', () => ({
  markMatchingPress: () => undefined,
  consumeMatchingPress: () => false,
}));

/**
 * Presence mock mirroring MobileWindowMotion: mount on open, retain during exit,
 * unmount only after explicit exit complete (no guessed delay).
 */
vi.mock('@/components/ui/MobileResizableSheet', () => {
  const MobileResizableSheet = ({
    open,
    children,
    onOpenChange,
  }: {
    open: boolean;
    children: React.ReactNode;
    onOpenChange: (open: boolean) => void;
    id?: string;
    ariaLabel?: string;
    closeAriaLabel?: string;
    resizeAriaLabel?: string;
    bodyClassName?: string;
    leading?: React.ReactNode;
  }) => {
    const [mounted, setMounted] = React.useState(open);
    React.useEffect(() => {
      if (open) setMounted(true);
    }, [open]);
    const completeExit = () => {
      if (!open) setMounted(false);
    };
    if (!mounted) return null;
    return (
      <div data-testid="mobile-model-sheet" data-open={String(open)}>
        {children}
        {!open ? (
          <button type="button" data-testid="complete-exit" onClick={completeExit}>
            complete-exit
          </button>
        ) : (
          <button type="button" data-testid="request-close" onClick={() => onOpenChange(false)}>
            close
          </button>
        )}
      </div>
    );
  };
  return { MobileResizableSheet };
});

const providers: ModelPickerProvider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4.1', name: 'GPT-4.1' },
    ],
  },
];

const favoriteModels: ModelPickerEntry[] = [
  { providerID: 'openai', modelID: 'gpt-4o', model: { id: 'gpt-4o', name: 'GPT-4o' } },
];

const recentModels: ModelPickerEntry[] = [
  { providerID: 'openai', modelID: 'gpt-4.1', model: { id: 'gpt-4.1', name: 'GPT-4.1' } },
];

describe('MobileModelPickerPanel closed-work gate', () => {
  let container: HTMLElement;
  let root: Root;
  let open: boolean;
  let setOpen: (next: boolean) => void;
  let parentTick: number;
  let setParentTick: (next: number) => void;
  let providersState: ModelPickerProvider[];
  let setProvidersState: (next: ModelPickerProvider[]) => void;

  const Host = () => {
    const [isOpen, setIsOpen] = React.useState(open);
    const [tick, setTick] = React.useState(parentTick);
    const [providerList, setProviderList] = React.useState(providersState);
    open = isOpen;
    setOpen = setIsOpen;
    parentTick = tick;
    setParentTick = setTick;
    providersState = providerList;
    setProvidersState = setProviderList;
    return (
      <div data-parent-tick={tick}>
        <MobileModelPickerPanel
          open={isOpen}
          onClose={() => setIsOpen(false)}
          selectedProviderID="openai"
          selectedModelID="gpt-4o"
          resolveSelectedVariant={() => undefined}
          onSelect={() => undefined}
          providers={providerList}
          favoriteModels={favoriteModels}
          recentModels={recentModels}
          isFavorite={() => false}
          onToggleFavorite={() => undefined}
          getMetadata={() => ({
            id: 'gpt-4o',
            providerId: 'openai',
            limit: { context: 128_000 },
          } as never)}
        />
      </div>
    );
  };

  beforeEach(() => {
    counters.formatTokensCalls = 0;
    counters.mergeMetadataCalls = 0;
    open = false;
    parentTick = 0;
    providersState = providers;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = '';
  });

  const renderHost = async () => {
    await act(async () => {
      root.render(<Host />);
    });
  };

  test('closed sheet builds no model rows under parent rerenders or provider churn', async () => {
    await renderHost();
    expect(container.querySelector('[data-testid="mobile-model-sheet"]')).toBeNull();
    expect(counters.formatTokensCalls).toBe(0);
    expect(counters.mergeMetadataCalls).toBe(0);

    await act(async () => {
      setParentTick(1);
    });
    await act(async () => {
      setProvidersState([
        ...providers,
        {
          id: 'anthropic',
          name: 'Anthropic',
          models: [{ id: 'claude-sonnet', name: 'Claude Sonnet' }],
        },
      ]);
    });
    await act(async () => {
      setParentTick(2);
    });

    expect(counters.formatTokensCalls).toBe(0);
    expect(counters.mergeMetadataCalls).toBe(0);
  });

  test('open → exit retain → fully exit → reopen gates expensive row work to presence', async () => {
    await renderHost();

    await act(async () => {
      setOpen(true);
    });
    expect(container.querySelector('[data-testid="mobile-model-sheet"]')).not.toBeNull();
    expect(counters.formatTokensCalls).toBeGreaterThan(0);
    expect(counters.mergeMetadataCalls).toBeGreaterThan(0);
    expect(container.textContent).toContain('gpt-4o');

    const formatWhileOpen = counters.formatTokensCalls;
    const mergeWhileOpen = counters.mergeMetadataCalls;

    await act(async () => {
      setOpen(false);
    });
    expect(container.querySelector('[data-testid="mobile-model-sheet"]')).not.toBeNull();
    expect(container.textContent).toContain('gpt-4o');

    const exitButton = container.querySelector<HTMLButtonElement>('[data-testid="complete-exit"]');
    await act(async () => {
      exitButton?.click();
    });
    expect(container.querySelector('[data-testid="mobile-model-sheet"]')).toBeNull();

    const formatAfterExit = counters.formatTokensCalls;
    const mergeAfterExit = counters.mergeMetadataCalls;
    await act(async () => {
      setParentTick(parentTick + 1);
    });
    await act(async () => {
      setProvidersState([
        {
          id: 'openai',
          name: 'OpenAI',
          models: [
            { id: 'gpt-4o', name: 'GPT-4o' },
            { id: 'o3', name: 'o3' },
          ],
        },
      ]);
    });
    expect(counters.formatTokensCalls).toBe(formatAfterExit);
    expect(counters.mergeMetadataCalls).toBe(mergeAfterExit);

    await act(async () => {
      setOpen(true);
    });
    expect(container.querySelector('[data-testid="mobile-model-sheet"]')).not.toBeNull();
    expect(counters.formatTokensCalls).toBeGreaterThan(formatWhileOpen);
    expect(counters.mergeMetadataCalls).toBeGreaterThan(mergeWhileOpen);
    expect(container.textContent).toContain('o3');
  });
});
