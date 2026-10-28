import React from 'react';
import { useGuiPlugins } from '@/lib/gui-plugins/react';
import { useI18n } from '@/lib/i18n';
import { scoreByFuzzyQuery } from '@/lib/search/fuzzySearch';
import { CommandGroup, CommandItem } from '@/components/ui/command';
import { toast } from '@/components/ui';

export function GuiPluginCommands({ query, onSelect }: { query: string; onSelect: () => void }) {
  const { host, snapshot, inventory, loading, error, requested, requestLoad, refresh } = useGuiPlugins();
  const { t } = useI18n();
  const [expandedQuery, setExpandedQuery] = React.useState<string | null>(null);
  React.useEffect(() => { if (!requested) requestLoad(); }, [requested, requestLoad]);
  const commands = React.useMemo(() => query.trim()
    ? scoreByFuzzyQuery([...snapshot.commands], query.trim(), (command) => `${command.title} ${command.description ?? ''}`, { threshold: 0.4 }).map(({ item }) => item)
    : snapshot.commands, [snapshot.commands, query]);
  const failure = error || inventory.find((plugin) => plugin.enabled && plugin.error)?.error
    || snapshot.plugins.find((plugin) => plugin.status === 'failed')?.error;
  if (!commands.length && !loading && !failure) return null;
  const visible = expandedQuery === query ? commands : commands.slice(0, 5);
  const run = async (key: string) => {
    onSelect();
    try { await host?.runCommand(key); } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t('guiPlugins.error'));
    }
  };
  return (
    <CommandGroup heading={t('guiPlugins.commands')}>
      {loading ? <CommandItem value="gui-plugin:loading" disabled><span role="status" aria-busy="true">{t('guiPlugins.loading')}</span></CommandItem> : null}
      {failure ? <CommandItem value="gui-plugin:retry" disabled={loading} onSelect={refresh}>
        <span role="alert" className="min-w-0 flex-1 break-words">{failure}</span><span>{t('guiPlugins.refresh')}</span>
      </CommandItem> : null}
      {visible.map((command) => <CommandItem key={command.key} value={`gui-plugin:${command.key}`}
        className="min-h-9 gap-2 rounded-lg px-3 py-2 typography-meta" onSelect={() => void run(command.key)}>
        <span className="min-w-0 flex-1 truncate">{command.title}</span>
        {command.description ? <span className="max-w-[50%] truncate text-muted-foreground">{command.description}</span> : null}
      </CommandItem>)}
      {visible.length < commands.length ? <CommandItem value="gui-plugin:show-more" onSelect={() => setExpandedQuery(query)}>
        {t('commandPalette.group.showMore', { count: commands.length - visible.length })}
      </CommandItem> : null}
    </CommandGroup>
  );
}
