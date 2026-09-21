import React from 'react';
import { useEvent } from '@reactuses/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';
import { useI18n } from '@/lib/i18n';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import {
  deleteSavedPermissionQuery,
  useSavedPermissionsQuery,
  type SavedPermissionScope,
} from '@/queries/savedPermissionQueries';

export const SavedPermissionsSection: React.FC = () => {
  const { t } = useI18n();
  const directory = useDirectoryStore((state) => state.currentDirectory);
  const client = useQueryClient();
  const { project, list, scope } = useSavedPermissionsQuery(directory);
  const deletion = useMutation({
    mutationFn: ({ scope: captured, id }: { scope: SavedPermissionScope; id: string }) => deleteSavedPermissionQuery(client, captured, id),
  });
  const sameMutationScope = deletion.variables && JSON.stringify(deletion.variables.scope) === JSON.stringify(scope);
  const failed = project.isError || list.isError;
  const loading = Boolean(scope.directory) && (project.isPending || list.isPending) && !failed;
  const items = list.data ?? [];
  const handleDelete = useEvent((id: string) => deletion.mutate({ scope, id }));
  const retry = useEvent(() => { void (project.isError ? project.refetch() : list.refetch()); });

  return (
    <div data-settings-item="permissions.saved" className="mb-6">
      <SettingsGroup
        label={t('settings.permissions.saved.title')}
        description={loading ? t('common.loading') : !failed && list.isSuccess && items.length === 0 ? t('settings.permissions.saved.empty') : undefined}
      >
        {failed && (
          <SettingsRow label={<span role="alert">{t('settings.permissions.saved.loadFailed')}</span>}>
            <Button type="button" variant="ghost" size="xs" onClick={retry} disabled={project.isFetching || list.isFetching}>
              {t('settings.permissions.saved.retry')}
            </Button>
          </SettingsRow>
        )}
        {sameMutationScope && deletion.isError && (
          <SettingsRow label={<span role="alert">{t('settings.permissions.saved.deleteFailed')}</span>}>{null}</SettingsRow>
        )}
        {items.map((item) => (
          <SettingsRow
            key={item.id}
            label={(
              <div className="flex items-center gap-2">
                <span>{item.action}</span>
                <span className="typography-micro text-muted-foreground font-mono">{item.resource}</span>
              </div>
            )}
          >
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={failed || loading || Boolean(sameMutationScope && deletion.isPending)}
              onClick={() => void handleDelete(item.id)}
            >
              {t('settings.permissions.saved.delete')}
            </Button>
          </SettingsRow>
        ))}
      </SettingsGroup>
    </div>
  );
};
