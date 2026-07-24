import React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useMcpConfigStore, type McpDraft, type McpServerConfig } from '@/stores/useMcpConfigStore';
import { useShallow } from 'zustand/react/shallow';
import { isMobileDeviceViaCSS } from '@/lib/device';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import { SettingsProjectSelector } from '@/components/sections/shared/SettingsProjectSelector';
import { SettingsGroup } from '@/components/sections/shared/SettingsGroup';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { useI18n } from '@/lib/i18n';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import {
  refreshMcpStatusQuery,
  resolveMcpConfigQueryDirectory,
  useMcpConfigsQuery,
  useMcpStatusQuery,
  type McpServerWithScope,
} from '@/queries/mcpQueries';

const EMPTY_MCP_SERVERS: McpServerWithScope[] = [];

interface McpSidebarProps {
  onItemSelect?: () => void;
}

// ---- Status dot ----
type StatusTone = 'success' | 'error' | 'warning' | 'idle';

const statusToneFromMcp = (status: string | undefined): StatusTone => {
  switch (status) {
    case 'connected': return 'success';
    case 'failed': return 'error';
    case 'needs_auth':
    case 'needs_client_registration': return 'warning';
    default: return 'idle';
  }
};

const StatusDot: React.FC<{ tone: StatusTone; enabled: boolean }> = ({ tone, enabled }) => {
  if (!enabled) {
    return (
      <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/30 flex-shrink-0" />
    );
  }
  const classes: Record<StatusTone, string> = {
    success: 'bg-[var(--status-success)]',
    error: 'bg-[var(--status-error)]',
    warning: 'bg-[var(--status-warning)]',
    idle: 'bg-muted-foreground/40',
  };
  return (
    <span className={cn('inline-block h-2 w-2 rounded-full flex-shrink-0', classes[tone])} />
  );
};

export const McpSidebar: React.FC<McpSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const { selectedMcpName, setSelectedMcp, setMcpDraft, deleteMcp } =
    useMcpConfigStore(useShallow((s) => ({
      selectedMcpName: s.selectedMcpName,
      setSelectedMcp: s.setSelectedMcp,
      setMcpDraft: s.setMcpDraft,
      deleteMcp: s.deleteMcp,
    })));

  const mcpDirectory = resolveMcpConfigQueryDirectory();
  const configsQuery = useMcpConfigsQuery(mcpDirectory);
  const statusQuery = useMcpStatusQuery(mcpDirectory);
  const mcpServers = configsQuery.data ?? EMPTY_MCP_SERVERS;
  const mcpStatus = statusQuery.data ?? {};

  const [deleteTarget, setDeleteTarget] = React.useState<McpServerConfig | null>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [openMenuMcp, setOpenMenuMcp] = React.useState<string | null>(null);
  const [rightClickMenuMcp, setRightClickMenuMcp] = React.useState<string | null>(null);
  const [isRefreshingStatus, setIsRefreshingStatus] = React.useState(false);

  const projectServers = React.useMemo(
    () => mcpServers.filter((server) => server.scope === 'project'),
    [mcpServers]
  );
  const userServers = React.useMemo(
    () => mcpServers.filter((server) => server.scope !== 'project'),
    [mcpServers]
  );

  const handleRefresh = React.useCallback(() => {
    if (isRefreshingStatus) return;

    setIsRefreshingStatus(true);
    const minSpinPromise = new Promise((resolve) => setTimeout(resolve, 500));

    const transport = getRuntimeTransportIdentity();
    Promise.all([
      refreshMcpStatusQuery(queryClient, mcpDirectory, transport),
      minSpinPromise,
    ]).catch((error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      setIsRefreshingStatus(false);
    });
  }, [isRefreshingStatus, mcpDirectory]);

  const handleCreateNew = () => {
    const baseName = 'new-mcp-server';
    let newName = baseName;
    let counter = 1;
    while (mcpServers.some((s) => s.name === newName)) {
      newName = `${baseName}-${counter}`;
      counter++;
    }

    const draft: McpDraft = {
      name: newName,
      scope: 'user',
      type: 'local',
      command: [],
      url: '',
      environment: [],
      headers: [],
      oauthEnabled: true,
      oauthClientId: '',
      oauthClientSecret: '',
      oauthScope: '',
      oauthRedirectUri: '',
      timeout: '',
      enabled: true,
    };
    setMcpDraft(draft);
    setSelectedMcp(newName);
    onItemSelect?.();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    const result = await deleteMcp(deleteTarget.name, {
      directory: resolveMcpConfigQueryDirectory(),
      transportIdentity: getRuntimeTransportIdentity(),
    });
    if (result.ok) {
      if (result.reloadFailed) {
        toast.warning(result.message || `MCP server "${deleteTarget.name}" deleted, but OpenCode reload failed`, {
          description: result.warning || t('settings.mcp.sidebar.toast.refreshListIfStale'),
        });
      } else {
        toast.success(result.message || t('settings.mcp.sidebar.toast.serverDeleted', { name: deleteTarget.name }));
      }
    } else {
      toast.error(t('settings.mcp.sidebar.toast.deleteFailed'));
    }
    setDeleteTarget(null);
    setIsDeleting(false);
  };

  const renderMcpMenuItems = (server: McpServerConfig, Item: React.ElementType) => (
    <Item
      onClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        setDeleteTarget(server);
      }}
      className="text-destructive focus:text-destructive"
    >
      <Icon name="delete-bin" className="h-4 w-4 mr-px" />
      {t('settings.common.actions.delete')}
    </Item>
  );

  const userServersLabel = (
    <div className="flex items-center justify-between gap-4">
      <span>{t('settings.mcp.sidebar.group.userServers')}</span>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={isRefreshingStatus}
          onClick={handleRefresh}
          aria-label={t('settings.mcp.sidebar.actions.refreshStatusAria')}
          title={t('settings.mcp.sidebar.actions.refreshStatusTitle')}
        >
          <Icon name="refresh" className={cn('h-4 w-4', isRefreshingStatus && 'animate-spin')} />
        </Button>
        <Button
          data-settings-item="mcp.create"
          size="icon"
          variant="ghost"
          onClick={handleCreateNew}
          aria-label={t('settings.mcp.sidebar.actions.addServerTitle')}
          title={t('settings.mcp.sidebar.actions.addServerTitle')}
        >
          <Icon name="add" className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="oc-settings-page-content h-full overflow-y-auto bg-background p-3">
      <SettingsGroup>
        <div className="oc-settings-group-row"><SettingsProjectSelector /></div>
      </SettingsGroup>

      {/* List */}
      <>
        {configsQuery.isError && !configsQuery.data ? (
          <SettingsGroup label={userServersLabel}>
            <div className="oc-settings-group-row py-12 text-center typography-meta text-[var(--status-error)]">
              {configsQuery.error.message}
            </div>
          </SettingsGroup>
        ) : mcpServers.length === 0 ? (
          <SettingsGroup label={userServersLabel}>
            <div className="oc-settings-group-row py-12 text-center text-muted-foreground">
              <Icon name="plug" className="mx-auto mb-3 h-10 w-10 opacity-50" />
              <p className="typography-ui-label font-medium">{t('settings.mcp.sidebar.empty.title')}</p>
              <p className="typography-meta mt-1 opacity-75">{t('settings.mcp.sidebar.empty.description')}</p>
            </div>
          </SettingsGroup>
        ) : (
          <>
            {projectServers.length > 0 && (
              <SettingsGroup label={t('settings.mcp.sidebar.group.projectServers')}>
                {projectServers.map((server) => {
                  const runtimeStatus = mcpStatus[server.name] ?? (
                    statusQuery.isError && !statusQuery.data
                      ? { status: 'failed' as const, error: statusQuery.error.message }
                      : undefined
                  );
                  const tone = statusToneFromMcp(runtimeStatus?.status);
                  const isSelected = selectedMcpName === server.name;
                  const isMobile = isMobileDeviceViaCSS();

                  return (
                    <ContextMenu key={server.name} open={rightClickMenuMcp === server.name} onOpenChange={(open) => setRightClickMenuMcp(open ? server.name : null)}>
                      <ContextMenuTrigger render={<div className={cn('oc-settings-group-row group relative flex items-center transition-colors duration-150 select-none', isSelected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover')} onContextMenu={!isMobile ? (e) => { e.preventDefault(); setRightClickMenuMcp(server.name); } : undefined} />}>
                      <button
                        onClick={() => {
                          setSelectedMcp(server.name);
                          setMcpDraft(null);
                          onItemSelect?.();
                        }}
                        className="flex min-w-0 flex-1 flex-col gap-0 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                      >
                        <div className="flex items-center gap-2">
                          <StatusDot tone={tone} enabled={server.enabled} />
                          <span className="typography-ui-label font-normal truncate text-foreground">{server.name}</span>
                          <span title={server.type === 'local'
                            ? t('settings.mcp.sidebar.serverType.localTitle')
                            : t('settings.mcp.sidebar.serverType.remoteTitle')}
                          >
                            {server.type === 'local' ? (
                              <Icon name="server" className="h-3 w-3 text-muted-foreground/60 flex-shrink-0" />
                            ) : (
                              <Icon name="global" className="h-3 w-3 text-muted-foreground/60 flex-shrink-0" />
                            )}
                          </span>
                        </div>
                        <div className="typography-micro text-muted-foreground/60 truncate leading-tight pl-4">
                          {server.type === 'local'
                            ? (server as { command?: string[] }).command?.join(' ') ?? ''
                            : (server as { url?: string }).url ?? ''}
                        </div>
                      </button>

                      <DropdownMenu open={openMenuMcp === server.name} onOpenChange={(open) => { if (open) setRightClickMenuMcp(null); setOpenMenuMcp(open ? server.name : null); }}>
                        <DropdownMenuTrigger asChild>
                          <Button size="xs" variant="ghost" className="flex-shrink-0 -mr-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
                            <Icon name="more-2" className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-fit min-w-20">
                          {renderMcpMenuItems(server, DropdownMenuItem)}
                        </DropdownMenuContent>
                      </DropdownMenu>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-fit min-w-20">
                        {renderMcpMenuItems(server, ContextMenuItem)}
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                })}
              </SettingsGroup>
            )}

            {userServers.length > 0 && (
              <SettingsGroup label={userServersLabel}>
                {userServers.map((server) => {
                  const runtimeStatus = mcpStatus[server.name] ?? (
                    statusQuery.isError && !statusQuery.data
                      ? { status: 'failed' as const, error: statusQuery.error.message }
                      : undefined
                  );
                  const tone = statusToneFromMcp(runtimeStatus?.status);
                  const isSelected = selectedMcpName === server.name;
                  const isMobile = isMobileDeviceViaCSS();

                  return (
                    <ContextMenu key={server.name} open={rightClickMenuMcp === server.name} onOpenChange={(open) => setRightClickMenuMcp(open ? server.name : null)}>
                      <ContextMenuTrigger render={<div className={cn('oc-settings-group-row group relative flex items-center transition-colors duration-150 select-none', isSelected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover')} onContextMenu={!isMobile ? (e) => { e.preventDefault(); setRightClickMenuMcp(server.name); } : undefined} />}>
                      <button
                        onClick={() => {
                          setSelectedMcp(server.name);
                          setMcpDraft(null);
                          onItemSelect?.();
                        }}
                        className="flex min-w-0 flex-1 flex-col gap-0 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                      >
                        <div className="flex items-center gap-2">
                          <StatusDot tone={tone} enabled={server.enabled} />
                          <span className="typography-ui-label font-normal truncate text-foreground">{server.name}</span>
                          <span title={server.type === 'local'
                            ? t('settings.mcp.sidebar.serverType.localTitle')
                            : t('settings.mcp.sidebar.serverType.remoteTitle')}
                          >
                            {server.type === 'local' ? (
                              <Icon name="server" className="h-3 w-3 text-muted-foreground/60 flex-shrink-0" />
                            ) : (
                              <Icon name="global" className="h-3 w-3 text-muted-foreground/60 flex-shrink-0" />
                            )}
                          </span>
                        </div>
                        <div className="typography-micro text-muted-foreground/60 truncate leading-tight pl-4">
                          {server.type === 'local'
                            ? (server as { command?: string[] }).command?.join(' ') ?? ''
                            : (server as { url?: string }).url ?? ''}
                        </div>
                      </button>

                      <DropdownMenu open={openMenuMcp === server.name} onOpenChange={(open) => { if (open) setRightClickMenuMcp(null); setOpenMenuMcp(open ? server.name : null); }}>
                        <DropdownMenuTrigger asChild>
                          <Button size="xs" variant="ghost" className="flex-shrink-0 -mr-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
                            <Icon name="more-2" className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-fit min-w-20">
                          {renderMcpMenuItems(server, DropdownMenuItem)}
                        </DropdownMenuContent>
                      </DropdownMenu>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-fit min-w-20">
                        {renderMcpMenuItems(server, ContextMenuItem)}
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                })}
              </SettingsGroup>
            )}
            {userServers.length === 0 && (
              <SettingsGroup label={userServersLabel} cardClassName="hidden">
                <span />
              </SettingsGroup>
            )}
          </>
        )}
      </>

      {/* Delete confirm dialog */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open && !isDeleting) setDeleteTarget(null); }}
      >
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t('settings.mcp.sidebar.deleteDialog.title')}</DialogTitle>
              <DialogDescription>
                {t('settings.mcp.sidebar.deleteDialog.descriptionPrefix', { name: deleteTarget?.name || '' })}{' '}
                <code className="text-foreground">opencode.json</code>.
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
            <Button size="sm" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? t('settings.mcp.sidebar.actions.deleting') : t('settings.common.actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

// Re-export for easy sidebar icon usage

import { Icon } from "@/components/icon/Icon";
