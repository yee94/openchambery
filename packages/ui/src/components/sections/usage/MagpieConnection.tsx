import React from 'react';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsGroup } from '@/components/sections/shared/SettingsGroup';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';

export function MagpieConnection() {
  const { t } = useI18n();
  const saved = useQuotaStore((s) => s.magpieUsageUrl);
  const sources = useQuotaStore((s) => s.magpieSources);
  const discoveryError = useQuotaStore((s) => s.magpieError);
  const refresh = useQuotaStore((s) => s.fetchMagpieQuotas);
  const [draft, setDraft] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(false);
  const inputId = React.useId();
  const providerCount = sources.reduce((count, source) => count + source.results.length, 0);
  const runtime = getRuntimeTransportIdentity();
  React.useEffect(() => { setDraft(null); setError(false); }, [runtime]);
  const save = useEvent(async () => {
    const identity = getRuntimeTransportIdentity();
    const value = (draft ?? saved).trim();
    setSaving(true); setError(false);
    try {
      if (value) {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid URL');
      }
      await updateDesktopSettings({ magpieUsageUrl: value });
      if (identity !== getRuntimeTransportIdentity()) return;
      useQuotaStore.setState({ magpieUsageUrl: value });
      setDraft(null);
      await refresh();
    } catch {
      if (identity === getRuntimeTransportIdentity()) setError(true);
    } finally { setSaving(false); }
  });
  return <SettingsGroup label="Magpie" itemId="usage.magpie">
    <div className="oc-settings-group-row min-w-0">
      <p className="typography-meta text-muted-foreground break-words">
        {providerCount > 0 ? t('settings.usage.magpie.connected', { count: providerCount }) : t('settings.usage.magpie.description')}
      </p>
      {(discoveryError || sources.some((source) => source.identified && source.error)) &&
        <p role="status" className="typography-meta text-muted-foreground">{t('settings.usage.magpie.unavailable')}</p>}
      <details className="mt-2 min-w-0">
        <summary className="cursor-pointer typography-meta text-muted-foreground hover:text-foreground">{t('settings.usage.magpie.manual')}</summary>
        <div className="mt-3 flex min-w-0 flex-col gap-2">
          <label htmlFor={inputId} className="typography-meta text-muted-foreground">{t('settings.usage.magpie.url')}</label>
          <Input id={inputId} className="w-full min-w-0" value={draft ?? saved} disabled={saving}
            onChange={(event) => setDraft(event.target.value)} aria-label={t('settings.usage.magpie.url')} />
          <Button className="self-end" size="sm" variant="outline" onClick={save} disabled={saving}>{t('settings.usage.magpie.save')}</Button>
          {error && <p role="alert" className="typography-meta text-[var(--status-error)]">{t('settings.usage.page.state.refreshFailedTitle')}</p>}
        </div>
      </details>
    </div>
  </SettingsGroup>;
}
