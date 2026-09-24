import React from 'react';
import { useEvent } from '@reactuses/core';
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
import { PluginStatusBadge } from './PluginStatusBadge';
import {
  configEntryRuntimeTarget,
  findRuntimeMatches,
  pluginFileRuntimeTarget,
  resolveUpdateFlag,
  type PluginRuntimeTarget,
} from './pluginLoadState';
import { isV1IncompatiblePlugin } from '@/lib/plugin-v1-compatibility';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { SettingsSidebarLayout } from '@/components/sections/shared/SettingsSidebarLayout';
import { SettingsSidebarItem } from '@/components/sections/shared/SettingsSidebarItem';
import { SettingsGroup } from '@/components/sections/shared/SettingsGroup';
import { useI18n } from '@/lib/i18n';
import {
  checkPluginRuntimeUpdates,
  pluginPackageUpdateKey,
  refreshPluginRegistryQuery,
  resolveConfigQueryDirectory,
  usePluginConfigDirectory,
  usePluginRegistryQuery,
  usePluginRuntimeQuery,
  usePluginsQuery,
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

  const { selectedId, setSelected, deleteEntry, deleteFile, loadPlugins, updateEntry, updatePackage, packageUpdates } =
    usePluginsStore(
      useShallow((s) => ({
        selectedId: s.selectedId,
        setSelected: s.setSelected,
        deleteEntry: s.deleteEntry,
        deleteFile: s.deleteFile,
        loadPlugins: s.loadPlugins,
        updateEntry: s.updateEntry,
        updatePackage: s.updatePackage,
        packageUpdates: s.packageUpdates,
      })),
    );

  const pluginsQuery = usePluginsQuery();
  const entries = React.useMemo(() => pluginsQuery.data?.entries ?? [], [pluginsQuery.data?.entries]);
  const files = React.useMemo(() => pluginsQuery.data?.files ?? [], [pluginsQuery.data?.files]);

  const specs = React.useMemo(() => entries.map((entry) => entry.spec), [entries]);
  const { data, isFetching } = usePluginRegistryQuery(specs, false);
  const registryInfo = React.useMemo(() => data ?? {}, [data]);
  const configDirectory = usePluginConfigDirectory();
  const runtimeQuery = usePluginRuntimeQuery();
  const runtimeUnavailable = runtimeQuery.isError && runtimeQuery.data === undefined;
  const [isCheckingUpdates, setIsCheckingUpdates] = React.useState(false);

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

  const runtimeTargets = React.useMemo(() => {
    const targets = new Map<string, PluginRuntimeTarget | null>();
    for (const entry of entries) targets.set(entry.id, configEntryRuntimeTarget(entry.spec, entry.sourcePath));
    for (const file of files) targets.set(file.id, pluginFileRuntimeTarget(file.absolutePath));
    return targets;
  }, [entries, files]);

  const openCodeUpdateTargets = React.useMemo(() => {
    const inventory = runtimeQuery.data;
    const targets = new Map<string, string>();
    if (!inventory) return targets;
    for (const entry of entries) {
      const target = runtimeTargets.get(entry.id);
      if (target?.kind !== 'package') continue;
      if (packageUpdates[pluginPackageUpdateKey(configDirectory, target.target)]?.kind === 'running') continue;
      if (resolveUpdateFlag(findRuntimeMatches(target, inventory)) === 'available') {
        targets.set(entry.id, target.target);
      }
    }
    return targets;
  }, [configDirectory, entries, packageUpdates, runtimeQuery.data, runtimeTargets]);

  const updateCounts = React.useMemo(() => {
    const counts = { userEntries: 0, projectEntries: 0 };
    for (const entry of entries) {
      const info = registryInfo[entry.spec];
      if ((info?.kind === 'npm-ok' && info.hasUpdate) || openCodeUpdateTargets.has(entry.id)) {
        if (entry.scope === 'user') counts.userEntries++;
        else if (entry.scope === 'project') counts.projectEntries++;
      }
    }
    return counts;
  }, [entries, openCodeUpdateTargets, registryInfo]);

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

  const handleOpenCodeUpdate = useEvent(async (target: string, pluginName: string) => {
    const ok = await updatePackage(target);
    if (ok) toast.success(t('settings.plugins.update.toast.done', { name: pluginName }));
    else toast.error(t('settings.plugins.update.toast.failed', { name: pluginName }));
  });

  const handleRefresh = useEvent(async () => {
    toast.info(t('settings.plugins.toast.refreshing'));
    setIsCheckingUpdates(true);
    const registryOk = await refreshPluginRegistryQuery(undefined, resolveConfigQueryDirectory(), specs)
      .then(() => true)
      .catch(() => false);
    const checkOk = await checkPluginRuntimeUpdates(configDirectory)
      .then(() => true)
      .catch(() => false);
    setIsCheckingUpdates(false);
    if (!registryOk) toast.error(t('settings.plugins.toast.refreshFailed'));
    if (!checkOk) toast.error(t('settings.plugins.toast.checkFailed'));
  });

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
    const updateTarget = openCodeUpdateTargets.get(entry.id) ?? null;
    const actions: Array<{
      label: string;
      icon?: IconName;
      destructive?: boolean;
      onClick: () => void;
    }> = [];
    if (updateTarget) {
      actions.push({
        label: t('settings.plugins.update.action'),
        icon: 'arrow-up-s',
        onClick: () => void handleOpenCodeUpdate(updateTarget, entry.spec),
      });
    } else if (canUpdate) {
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
            <PluginStatusBadge target={runtimeTargets.get(entry.id) ?? null} />
            {isV1IncompatiblePlugin(entry) ? (
              <span
                className="typography-micro shrink-0 rounded-full border border-[var(--status-warning)] px-1.5 py-0.5 text-[var(--status-warning)]"
                title={t('settings.plugins.compatibility.v1Incompatible.tooltip')}
              >
                {t('settings.plugins.compatibility.v1Incompatible')}
              </span>
            ) : null}
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
      title={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate">{file.fileName}</span>
          <PluginStatusBadge target={runtimeTargets.get(file.id) ?? null} />
          {isV1IncompatiblePlugin(file) ? (
            <span
              className="typography-micro shrink-0 rounded-full border border-[var(--status-warning)] px-1.5 py-0.5 text-[var(--status-warning)]"
              title={t('settings.plugins.compatibility.v1Incompatible.tooltip')}
            >
              {t('settings.plugins.compatibility.v1Incompatible')}
            </span>
          ) : null}
        </span>
      }
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
        disabled={isFetching || runtimeQuery.isFetching || isCheckingUpdates}
        aria-label={t('settings.plugins.sidebar.actions.refresh')}
        title={t('settings.plugins.sidebar.actions.refresh')}
      >
        <Icon name="refresh" className={isFetching || runtimeQuery.isFetching || isCheckingUpdates ? 'size-4 animate-spin' : 'size-4'} />
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
      <SettingsSidebarLayout
        variant="background"
        header={runtimeUnavailable ? (
          <p className="typography-micro mb-2 flex items-center gap-1 text-muted-foreground" role="status">
            <Icon name="question" className="size-3 shrink-0" />
            {t('settings.plugins.status.sidebar.unavailable')}
          </p>
        ) : undefined}
      >
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
