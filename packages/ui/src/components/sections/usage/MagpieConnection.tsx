import React from 'react';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';
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
  return <SettingsGroup label="Magpie" description={t('settings.usage.magpie.description')}>
    <SettingsRow itemId="usage.magpie" label={t('settings.usage.magpie.url')}>
      <div className="flex min-w-0 items-center gap-2">
        <Input value={draft ?? saved} disabled={saving} onChange={(event) => setDraft(event.target.value)} aria-label={t('settings.usage.magpie.url')} />
        <Button size="sm" variant="outline" onClick={save} disabled={saving}>{t('settings.usage.magpie.save')}</Button>
      </div>
    </SettingsRow>
    {(error || discoveryError) && <p role="alert" className="oc-settings-group-row text-[var(--status-error)]">{t('settings.usage.page.state.refreshFailedTitle')}</p>}
    {sources.filter((s) => s.identified || s.results.length > 0).map((source) => <div key={source.id} className="oc-settings-group-row">
      <span className="typography-meta">{source.name} · {source.results.length}</span>
      {source.error && <p role="alert" className="typography-meta text-[var(--status-error)]">{source.error}</p>}
    </div>)}
  </SettingsGroup>;
}
