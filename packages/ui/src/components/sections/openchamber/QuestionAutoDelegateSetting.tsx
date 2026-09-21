import { useMutation } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { useQuestionAutoDelegate, refreshQuestionAutoDelegate } from '@/lib/questionAutoDelegate';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeGeneration } from '@/lib/runtime-switch';
import { Button } from '@/components/ui/button';
import { SettingsGroup, SettingsToggleRow } from '../shared/SettingsGroup';

export function QuestionAutoDelegateSetting() {
  const { t } = useI18n();
  const { settings } = useRuntimeAPIs();
  const query = useQuestionAutoDelegate();
  const generation = getRuntimeGeneration();
  const save = useMutation({
    mutationFn: async (enabled: boolean) => {
      const generation = getRuntimeGeneration();
      await settings.save({ questionAutoDelegateEnabled: enabled });
      if (generation !== getRuntimeGeneration()) throw new Error('Runtime changed');
      await refreshQuestionAutoDelegate();
    },
  }, queryClient);
  const resetSave = save.reset;
  useEffect(() => { resetSave(); }, [generation, resetSave]);
  return <SettingsGroup description={t('settings.chat.questionDelegate.description')}>
    <SettingsToggleRow
      itemId="chat.question-auto-delegate"
      label={t('settings.chat.questionDelegate.label')}
      ariaLabel={t('settings.chat.questionDelegate.label')}
      checked={query.data?.snapshot.enabled ?? true}
      disabled={save.isPending || !query.data || query.isError}
      onChange={(enabled) => save.mutate(enabled)}
    />
    {save.isPending ? <div className="oc-settings-group-row typography-meta text-muted-foreground" role="status">{t('settings.common.actions.saving')}</div> : null}
    {query.isError || save.isError ? <div className="oc-settings-group-row flex flex-wrap items-center gap-2" role="alert">
      <span className="typography-meta text-[var(--status-error)]">{t(save.isError ? 'settings.chat.questionDelegate.saveFailed' : 'chat.questionDelegate.loadFailed')}</span>
      <Button variant="ghost" size="xs" disabled={save.isPending} onClick={() => save.isError ? save.mutate(save.variables ?? true) : void query.refetch()}>{t('chat.questionDelegate.retry')}</Button>
    </div> : null}
  </SettingsGroup>;
}
