import React from 'react';
import { useGuiPlugins } from '@/lib/gui-plugins/react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { GuiPluginMount } from './GuiPluginMount';
import { GuiPluginWindow } from './GuiPluginWindow';
import { guiPluginReadinessKey } from './readiness';

export function GuiPluginSurface() {
  const { host, snapshot, error } = useGuiPlugins();
  const { t } = useI18n();
  const reported = React.useRef<{ host: typeof host; errors: Set<string> }>({ host, errors: new Set() });
  React.useEffect(() => {
    if (reported.current.host !== host) reported.current = { host, errors: new Set() };
    const errors = new Set<string>();
    for (const plugin of snapshot.plugins) {
      if (plugin.status !== 'failed') continue;
      const message = plugin.error || t('guiPlugins.failed');
      const key = JSON.stringify([plugin.id, message]);
      errors.add(key);
      if (!reported.current.errors.has(key)) toast.error(`${plugin.id}: ${message}`);
    }
    reported.current.errors = errors;
  }, [host, snapshot.plugins, t]);
  const active = snapshot.panels.find((panel) => panel.key === snapshot.activePanel && !panel.inline);
  return (
    <GuiPluginWindow id="gui-plugin-panel" open={Boolean(host && active)} title={active?.title ?? t('guiPlugins.title')} onClose={() => host?.hidePanel()}>
      {host && active ? <>
      <div className="flex shrink-0 flex-wrap gap-1" aria-label={t('guiPlugins.panels')}>
        {snapshot.panels.map((panel) => (
          <div key={panel.key} className="flex min-w-0 items-center gap-1">
            <Button variant="chip" size="sm" aria-pressed={panel.key === active.key}
              onClick={() => host.selectPanel(panel.key)} className="max-w-64 truncate">{panel.title}</Button>
            <Button variant="ghost" size="xs" aria-label={t('guiPlugins.closePanel', { title: panel.title })}
              onClick={() => host.closePanel(panel.key)}>{t('guiPlugins.close')}</Button>
          </div>
        ))}
      </div>
      {error ? <div role="alert" className="text-[var(--status-error)]">{error}</div> : null}
      <GuiPluginMount host={host} contributionKey={active.key} kind="panel" revision={guiPluginReadinessKey(snapshot.plugins, active.pluginId)} />
      </> : null}
    </GuiPluginWindow>
  );
}
