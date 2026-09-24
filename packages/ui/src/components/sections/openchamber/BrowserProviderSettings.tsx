import React from 'react';
import { useEvent } from '@reactuses/core';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui';
import { SettingsField } from '@/components/sections/shared/SettingsGroup';
import { shouldShowBrowserProviderSettings } from '@/lib/browser-provider/contract';
import { useI18n } from '@/lib/i18n';
import { useBrowserProviderCatalogQuery, useSelectBrowserProvider } from '@/queries/browserProviderQueries';

/**
 * Chooses which installed extension answers the agent's browser actions.
 * Hidden unless the host listed at least one provider — an empty select must
 * not look like a connected browser.
 */
export const BrowserProviderSettings: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useI18n();
  const catalog = useBrowserProviderCatalogQuery();
  const selection = useSelectBrowserProvider();
  const providers = catalog.data?.providers ?? [];
  const selectedId = catalog.data?.selectedId ?? null;
  const visible = shouldShowBrowserProviderSettings(catalog.data);

  const handleChange = useEvent((value: string) => {
    if (!providers.some((provider) => provider.id === value) || value === selectedId) return;
    selection.mutate(value, {
      onError: () => {
        toast.error(t('settings.openchamber.browserProvider.toast.selectFailed'));
      },
    });
  });

  if (!visible) return null;

  const selected = providers.find((provider) => provider.id === selectedId) ?? null;

  return (
    <SettingsField
      itemId="sessions.browser-provider"
      label={t('settings.openchamber.browserProvider.label')}
      description={t('settings.openchamber.browserProvider.info')}
      descriptionPlacement="outside"
      groupClassName={className}
      ariaLabel={t('settings.openchamber.browserProvider.aria')}
    >
      <Select<string>
        value={selected?.id}
        onValueChange={handleChange}
        disabled={selection.isPending}
      >
        <SelectTrigger
          className="oc-settings-inline-value w-fit max-w-full"
          aria-label={t('settings.openchamber.browserProvider.aria')}
        >
          <SelectValue placeholder={t('settings.openchamber.browserProvider.placeholder')}>
            {selected?.name ?? t('settings.openchamber.browserProvider.placeholder')}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {providers.map((provider) => (
            <SelectItem key={provider.id} value={provider.id}>
              {provider.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsField>
  );
};
