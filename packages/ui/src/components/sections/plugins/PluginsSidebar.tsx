import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AddPluginDialog } from './AddPluginDialog';
import { RegistryBadge } from './RegistryBadge';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { SettingsSidebarLayout } from '@/components/sections/shared/SettingsSidebarLayout';
import { SettingsSidebarItem } from '@/components/sections/shared/SettingsSidebarItem';
import { SettingsGroup } from '@/components/sections/shared/SettingsGroup';
import { useI18n } from '@/lib/i18n';
import {
  refreshPluginRegistryQuery,
  resolveConfigQueryDirectory,
  usePluginRegistryQuery,
} from '@/queries/pluginQueries';
import {
  usePluginsStore,
  type PluginEntry,
  type PluginFile,
} from '@/stores/usePluginsStore';

interface PluginsSidebarProps {
  onItemSelect?: () => void;
  onAddClick?: () => void;
}

type DeleteTarget =
  | { kind: 'entry'; id: string; label: string }
  | { kind: 'file'; id: string; label: string }
  | null;

const entryIcon = (entry: PluginEntry): IconName =>
  entry.parsedKind === 'npm' ? 'code-box' : 'folder';

export const PluginsSidebar: React.FC<PluginsSidebarProps> = ({
  onItemSelect,
  onAddClick,
}) => {
  const { t } = useI18n();

  const { entries, files, selectedId, setSelected, deleteEntry, deleteFile, loadPlugins, updateEntry } =
    usePluginsStore(
      useShallow((s) => ({
        entries: s.entries,
        files: s.files,
        selectedId: s.selectedId,
        setSelected: s.setSelected,
        deleteEntry: s.deleteEntry,
        deleteFile: s.deleteFile,
        loadPlugins: s.loadPlugins,
        updateEntry: s.updateEntry,
      })),
    );

  const specs = React.useMemo(() => entries.map((entry) => entry.spec), [entries]);
  const { data, isFetching } = usePluginRegistryQuery(specs, false);
  const registryInfo = React.useMemo(() => data ?? {}, [data]);

  const [deleteTarget, setDeleteTarget] = React.useState<DeleteTarget>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [isAddOpen, setIsAddOpen] = React.useState(false);

  React.useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  React.useEffect(() => {
    const handleOpenAdd = () => setIsAddOpen(true);
    window.addEventListener('openchamber:settings-open-plugin-add', handleOpenAdd);
    return () => window.removeEventListener('openchamber:settings-open-plugin-add', handleOpenAdd);
  }, []);

  const updateCounts = React.useMemo(() => {
    const counts = { userEntries: 0, projectEntries: 0 };
    for (const entry of entries) {
      const info = registryInfo[entry.spec];
      if (info?.kind === 'npm-ok' && info.hasUpdate) {
        if (entry.scope === 'user') counts.userEntries++;
        else if (entry.scope === 'project') counts.projectEntries++;
      }
    }
    return counts;
  }, [entries, registryInfo]);

  const userEntries = React.useMemo(
    () => entries.filter((e) => e.scope === 'user'),
    [entries],
  );
  const projectEntries = React.useMemo(
    () => entries.filter((e) => e.scope === 'project'),
    [entries],
  );
  const userFiles = React.useMemo(
    () => files.filter((f) => f.scope === 'user'),
    [files],
  );
  const projectFiles = React.useMemo(
    () => files.filter((f) => f.scope === 'project'),
    [files],
  );

  const total = entries.length + files.length;
  const isEmpty = total === 0;

  const handleAdd = React.useCallback(() => {
    if (onAddClick) {
      onAddClick();
    } else {
      setIsAddOpen(true);
    }
  }, [onAddClick]);

  const handleSelect = React.useCallback(
    (id: string) => {
      setSelected(id);
      onItemSelect?.();
    },
    [onItemSelect, setSelected],
  );

  const handleUpdateToLatest = React.useCallback(
    async (id: string) => {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return;
      const info = registryInfo[entry.spec];
      if (!info || info.kind !== 'npm-ok' || !info.hasUpdate || !info.latestVersion) {
        return;
      }
      const latest = info.latestVersion;
      const result = await updateEntry(id, { spec: `${info.name}@${latest}` });
      if (result.ok) {
        toast.success(
          t('settings.plugins.toast.updatedToLatest', { version: latest }),
        );
      } else {
        toast.error(t('settings.plugins.toast.refreshFailed'));
      }
    },
    [entries, registryInfo, t, updateEntry],
  );

  const handleRefresh = React.useCallback(async () => {
    toast.info(t('settings.plugins.toast.refreshing'));
    try {
      await refreshPluginRegistryQuery(undefined, resolveConfigQueryDirectory(), specs);
    } catch {
      toast.error(t('settings.plugins.toast.refreshFailed'));
    }
  }, [specs, t]);

  const handleDelete = React.useCallback(async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    const result =
      deleteTarget.kind === 'entry'
        ? await deleteEntry(deleteTarget.id)
        : await deleteFile(deleteTarget.id);
    if (result.ok) {
      toast.success(
        result.message ||
          t('settings.plugins.sidebar.toast.deleted', { name: deleteTarget.label }),
      );
    } else {
      toast.error(t('settings.plugins.sidebar.toast.deleteFailed'));
    }
    setDeleteTarget(null);
    setIsDeleting(false);
  }, [deleteEntry, deleteFile, deleteTarget, t]);

  const renderEntry = (entry: PluginEntry) => {
    const info = registryInfo[entry.spec];
    const canUpdate =
      info?.kind === 'npm-ok' && info.hasUpdate && !!info.latestVersion;
    const actions: Array<{
      label: string;
      icon?: IconName;
      destructive?: boolean;
      onClick: () => void;
    }> = [];
    if (canUpdate) {
      actions.push({
        label: t('settings.plugins.sidebar.actions.updateToLatest'),
        icon: 'arrow-up-s',
        onClick: () => void handleUpdateToLatest(entry.id),
      });
    }
    actions.push({
      label: t('settings.common.actions.delete'),
      icon: 'delete-bin',
      destructive: true,
      onClick: () =>
        setDeleteTarget({ kind: 'entry', id: entry.id, label: entry.spec }),
    });
    return (
      <SettingsSidebarItem
        key={entry.id}
        title={
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate">{entry.spec}</span>
            <RegistryBadge info={info} />
          </span>
        }
        metadata={
          entry.parsedKind === 'npm'
            ? t('settings.plugins.sidebar.kind.npm')
            : t('settings.plugins.sidebar.kind.path')
        }
        selected={selectedId === entry.id}
        onSelect={() => handleSelect(entry.id)}
        icon={
          <Icon
            name={entryIcon(entry)}
            className="h-4 w-4 flex-shrink-0 text-muted-foreground/70"
          />
        }
        actions={actions}
      />
    );
  };

  const renderFile = (file: PluginFile) => (
    <SettingsSidebarItem
      key={file.id}
      title={file.fileName}
      metadata={t('settings.plugins.sidebar.kind.file')}
      selected={selectedId === file.id}
      onSelect={() => handleSelect(file.id)}
      icon={
        <Icon
          name="file-text"
          className="h-4 w-4 flex-shrink-0 text-muted-foreground/70"
        />
      }
      actions={[
        {
          label: t('settings.common.actions.delete'),
          icon: 'delete-bin',
          destructive: true,
          onClick: () =>
            setDeleteTarget({ kind: 'file', id: file.id, label: file.fileName }),
        },
      ]}
    />
  );

  const renderGroup = (
    label: string,
    children: React.ReactNode,
    updateCount = 0,
    actions?: React.ReactNode,
    hideCard = false,
  ) => (
    <SettingsGroup
      cardClassName={hideCard ? 'hidden' : undefined}
      label={(
        <div className="flex items-center justify-between gap-4">
          <span>
            {label}
            {updateCount > 0 && (
              <span className="ml-2 text-[var(--status-success)]">
                {t(
                  updateCount === 1
                    ? 'settings.plugins.sidebar.group.updatesAvailable_one'
                    : 'settings.plugins.sidebar.group.updatesAvailable_other',
                  { count: updateCount },
                )}
              </span>
            )}
          </span>
          {actions}
        </div>
      )}
    >
      {children}
    </SettingsGroup>
  );

  const pluginHeaderActions = (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => void handleRefresh()}
        disabled={isFetching}
        aria-label={t('settings.plugins.sidebar.actions.refresh')}
        title={t('settings.plugins.sidebar.actions.refresh')}
      >
        <Icon name="refresh" className={isFetching ? 'size-4 animate-spin' : 'size-4'} />
      </Button>
      <Button
        data-settings-item="plugins.create"
        type="button"
        variant="ghost"
        size="icon"
        onClick={handleAdd}
        aria-label={t('settings.plugins.sidebar.actions.addTitle')}
        title={t('settings.plugins.sidebar.actions.addTitle')}
      >
        <Icon name="add" className="size-4" />
      </Button>
    </div>
  );

  return (
    <>
      <SettingsSidebarLayout variant="background">
        {userEntries.length > 0
          ? renderGroup(
              t('settings.plugins.sidebar.group.userEntries'),
              userEntries.map(renderEntry),
              updateCounts.userEntries,
              pluginHeaderActions,
            )
          : renderGroup(
              t('settings.plugins.sidebar.group.userEntries'),
              <span />,
              0,
              pluginHeaderActions,
              true,
            )}

        {isEmpty ? (
          <SettingsGroup>
            <div className="oc-settings-group-row py-12 text-center text-muted-foreground">
              <Icon name="plug" className="mx-auto mb-3 h-10 w-10 opacity-50" />
              <p className="typography-ui-label font-medium">
                {t('settings.plugins.sidebar.empty.title')}
              </p>
              <p className="typography-meta mt-1 opacity-75">
                {t('settings.plugins.sidebar.empty.description')}
              </p>
            </div>
          </SettingsGroup>
        ) : (
          <>
            {userFiles.length > 0 &&
              renderGroup(
                t('settings.plugins.sidebar.group.userFiles'),
                userFiles.map(renderFile),
              )}
            {projectEntries.length > 0 &&
              renderGroup(
                t('settings.plugins.sidebar.group.projectEntries'),
                projectEntries.map(renderEntry),
                updateCounts.projectEntries,
              )}
            {projectFiles.length > 0 &&
              renderGroup(
                t('settings.plugins.sidebar.group.projectFiles'),
                projectFiles.map(renderFile),
              )}
          </>
        )}
      </SettingsSidebarLayout>

      <AddPluginDialog open={isAddOpen} onOpenChange={setIsAddOpen} />

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !isDeleting) setDeleteTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('settings.plugins.sidebar.deleteDialog.title')}
            </DialogTitle>
            <DialogDescription>
              {t('settings.plugins.sidebar.deleteDialog.description', {
                name: deleteTarget?.label ?? '',
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDeleteTarget(null)}
              disabled={isDeleting}
            >
              {t('settings.common.actions.cancel')}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
            >
              {isDeleting
                ? t('settings.plugins.sidebar.actions.deleting')
                : t('settings.common.actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
