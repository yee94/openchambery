import React from 'react';

import { Button } from '@/components/ui/button';
import { SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';
import { useI18n } from '@/lib/i18n';
import { useProjectsStore } from '@/stores/useProjectsStore';
import {
  deletePermissionSaved,
  listPermissionSaved,
  type PermissionSavedInfo,
} from '@/sync/permission-saved-api';

export const SavedPermissionsSection: React.FC = () => {
  const { t } = useI18n();
  const projectID = useProjectsStore((state) => state.activeProjectId);
  const [items, setItems] = React.useState<PermissionSavedInfo[]>([]);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    if (!projectID) {
      setItems([]);
      return;
    }
    try {
      setItems(await listPermissionSaved({ projectID }));
    } catch (error) {
      console.error('[SavedPermissionsSection] Failed to list saved permissions:', error);
    }
  }, [projectID]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const handleDelete = async (id: string) => {
    setBusyId(id);
    try {
      await deletePermissionSaved({ id });
      setItems((current) => current.filter((item) => item.id !== id));
    } catch (error) {
      console.error('[SavedPermissionsSection] Failed to delete saved permission:', error);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div data-settings-item="permissions.saved" className="mb-6">
      <SettingsGroup
        label={t('settings.permissions.saved.title')}
        description={items.length === 0 ? t('settings.permissions.saved.empty') : undefined}
      >
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
              disabled={busyId === item.id}
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
