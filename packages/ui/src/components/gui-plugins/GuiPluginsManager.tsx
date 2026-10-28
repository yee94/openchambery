import React from 'react';
import { useGuiPlugins } from '@/lib/gui-plugins/react';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { SettingsGroup, SettingsRow, SettingsToggleRow } from '@/components/sections/shared/SettingsGroup';
import { GuiPluginMount } from './GuiPluginMount';
import { GuiPluginWindow } from './GuiPluginWindow';
import { guiPluginReadinessKey } from './readiness';

export function GuiPluginsManager() {
  const { host, snapshot, inventory, error, loading, requested, requestLoad, setEnabled, refresh } = useGuiPlugins();
  const { t } = useI18n();
  const [selected, setSelected] = React.useState<{ host: typeof host; key: string } | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const settings = selected?.host === host ? snapshot.settings.find((item) => item.key === selected?.key) : undefined;
  const selectionExists = Boolean(settings);
  React.useEffect(() => { if (!requested) requestLoad(); }, [requested, requestLoad]);
  React.useEffect(() => {
    if (selected && (selected.host !== host || !selectionExists)) setSelected(null);
  }, [host, selected, selectionExists]);
  const statuses = new Map(snapshot.plugins.map((plugin) => [plugin.id, plugin]));
  const act = async (action: () => void | Promise<void>) => {
    setActionError(null);
    try { await action(); } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t('guiPlugins.error'));
    }
  };

  return (
    <div className="yuri-settings-section-stack">
      <SettingsGroup label={t('guiPlugins.title')} actions={
        <Button size="sm" disabled={loading} onClick={() => void act(refresh)}>{t('guiPlugins.refresh')}</Button>
      }>
        {loading ? <SettingsRow label={t('common.loading')}><span role="status" aria-busy /></SettingsRow> : null}
        {inventory.length === 0 && !loading ? <SettingsRow label={t('guiPlugins.empty')}>{null}</SettingsRow> : null}
        {inventory.map((plugin) => {
          const status = statuses.get(plugin.id);
          const failure = plugin.error || status?.error;
          return <SettingsToggleRow key={plugin.id} label={plugin.id}
            ariaLabel={t('guiPlugins.enable', { id: plugin.id })} checked={plugin.enabled} disabled={loading}
            onChange={(enabled) => void act(() => setEnabled(plugin.id, enabled))}
            description={failure ? <span role="alert" className="text-[var(--status-error)]">{failure}</span>
              : t(!plugin.enabled ? 'guiPlugins.disabled' : status?.status === 'active' ? 'guiPlugins.active' : status?.status === 'failed' ? 'guiPlugins.failed' : 'guiPlugins.pending')} />;
        })}
      </SettingsGroup>
      {error || actionError ? <div role="alert" className="text-[var(--status-error)]">{actionError || error}</div> : null}
      {snapshot.commands.length ? <SettingsGroup label={t('guiPlugins.commands')}>
        {snapshot.commands.map((command) => <SettingsRow key={command.key} label={command.title} description={command.description}>
          <Button size="sm" disabled={!host} onClick={() => void act(() => host?.runCommand(command.key))}>{t('guiPlugins.run')}</Button>
        </SettingsRow>)}
      </SettingsGroup> : null}
      {snapshot.panels.length || snapshot.menuItems.length ? <SettingsGroup label={t('guiPlugins.panels')}>
        {snapshot.menuItems.map((item) => <SettingsRow key={`menu:${item.key}`} label={item.title} description={item.description}>
          <Button size="sm" disabled={!host} onClick={() => void act(item.run)}>{t('guiPlugins.open')}</Button>
        </SettingsRow>)}
        {snapshot.panels.map((panel) => <SettingsRow key={`panel:${panel.key}`} label={panel.title}>
          <Button size="sm" disabled={!host} onClick={() => void act(() => host?.selectPanel(panel.key))}>{t('guiPlugins.open')}</Button>
        </SettingsRow>)}
      </SettingsGroup> : null}
      {snapshot.settings.length ? <SettingsGroup label={t('guiPlugins.settings')}>
        {snapshot.settings.map((item) => <SettingsRow key={item.key} label={item.title}>
          <Button size="sm" disabled={!host} onClick={() => setSelected({ host, key: item.key })}>{t('guiPlugins.open')}</Button>
        </SettingsRow>)}
      </SettingsGroup> : null}
      <GuiPluginWindow id="gui-plugin-settings" open={Boolean(host && settings)} title={settings?.title ?? t('guiPlugins.settings')} onClose={() => setSelected(null)}>
        {host && settings ? <GuiPluginMount host={host} contributionKey={settings.key} kind="settings" revision={guiPluginReadinessKey(snapshot.plugins, settings.pluginId)} /> : null}
      </GuiPluginWindow>
    </div>
  );
}
