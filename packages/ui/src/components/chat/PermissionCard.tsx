import React from 'react';
import { cn } from '@/lib/utils';
import type { PermissionRequest, PermissionResponse } from '@/types/permission';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessions } from '@/sync/sync-context';
import * as sessionActions from '@/sync/session-actions';
import { WorkerHighlightedCode } from '@/components/code/WorkerHighlightedCode';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import { DiffPreview, WritePreview } from './DiffPreview';
import { JsonSummaryView } from './message/parts/JsonSummaryView';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { QuestionCardFrame } from './QuestionCardFrame';

const PERMISSION_BASH_CUSTOM_STYLE: React.CSSProperties = {
  margin: 0,
  padding: '0.5rem',
  fontSize: 'var(--text-meta)',
  lineHeight: '1.25rem',
  background: 'rgb(var(--muted) / 0.3)',
  borderRadius: '0.25rem',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  overflowWrap: 'break-word',
  overflow: 'visible',
};

const PERMISSION_BASH_CODE_TAG_PROPS = {
  style: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    overflowWrap: 'break-word',
  } as React.CSSProperties,
};

interface PermissionCardProps {
  permission: PermissionRequest;
  onResponse?: (response: 'once' | 'always' | 'reject') => void;
}

const getToolIcon = (toolName: string) => {
  const iconClass = "h-3 w-3";
  const tool = toolName.toLowerCase();

  if (tool === 'edit' || tool === 'multiedit' || tool === 'str_replace' || tool === 'str_replace_based_edit_tool') {
    return <Icon name="pencil-ai" className={iconClass} />;
  }

  if (tool === 'write' || tool === 'create' || tool === 'file_write') {
    return <Icon name="file-edit" className={iconClass} />;
  }

  if (tool === 'bash' || tool === 'shell' || tool === 'cmd' || tool === 'terminal' || tool === 'shell_command') {
    return <Icon name="terminal-box" className={iconClass} />;
  }

  if (tool === 'webfetch' || tool === 'fetch' || tool === 'curl' || tool === 'wget') {
    return <Icon name="global" className={iconClass} />;
  }

  return <Icon name="tools" className={iconClass} />;
};

const getToolDisplayName = (toolName: string): string => {
  const tool = toolName.toLowerCase();

  if (tool === 'edit' || tool === 'multiedit' || tool === 'str_replace' || tool === 'str_replace_based_edit_tool') {
    return 'edit';
  }
  if (tool === 'write' || tool === 'create' || tool === 'file_write') {
    return 'write';
  }
  if (tool === 'bash' || tool === 'shell' || tool === 'cmd' || tool === 'terminal' || tool === 'shell_command') {
    return 'bash';
  }
  if (tool === 'webfetch' || tool === 'fetch' || tool === 'curl' || tool === 'wget') {
    return 'webfetch';
  }

  return toolName;
};

const normalizeMetadataKey = (key: string): string => {
  if (key === 'filepath' || key === 'file_path') return 'filePath';
  if (key === 'parentDir' || key === 'parent_dir') return 'parentDirectory';
  return key;
};

const StructuredPermissionData = ({ data }: { data: unknown }) => (
  <div className="rounded-lg border border-border/20 bg-muted/15 px-2 py-1 sm:px-2.5 sm:py-1.5 [&_.typography-meta]:!text-xs [&_summary]:py-1">
    <JsonSummaryView data={data} />
  </div>
);

export const PermissionCard: React.FC<PermissionCardProps> = ({
  permission,
  onResponse
}) => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const [isResponding, setIsResponding] = React.useState(false);
  const [hasResponded, setHasResponded] = React.useState(false);
  const respondToPermission = sessionActions.respondToPermission;
  const sessions = useSessions();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const isFromSubagent = React.useMemo(() => {
    if (!currentSessionId || permission.sessionID === currentSessionId) return false;
    const sourceSession = sessions.find((session) => session.id === permission.sessionID);
    return Boolean(sourceSession?.parentID && sourceSession.parentID === currentSessionId);
  }, [permission.sessionID, currentSessionId, sessions]);

  const handleResponse = async (response: PermissionResponse) => {
    setIsResponding(true);

    try {
      await respondToPermission(permission.sessionID, permission.id, response);
      setHasResponded(true);
      onResponse?.(response);
    } catch (error) {
      console.error('[PermissionCard] Failed to respond to permission:', error);
    } finally {
      setIsResponding(false);
    }
  };

  if (hasResponded) {
    return null;
  }

  const toolName = permission.permission || 'unknown';
  const tool = toolName.toLowerCase();

  const getMeta = (key: string, fallback: string = ''): string => {
    const val = permission.metadata[key];
    return typeof val === 'string' ? val : (typeof val === 'number' ? String(val) : fallback);
  };
  const getMetaNum = (key: string): number | undefined => {
    const val = permission.metadata[key];
    return typeof val === 'number' ? val : undefined;
  };
  const getMetaBool = (key: string): boolean => {
    const val = permission.metadata[key];
    return Boolean(val);
  };
  const displayToolName = getToolDisplayName(toolName);
  const displayMetadata = Object.fromEntries(
    Object.entries(permission.metadata)
      .filter(([key]) => key !== 'always')
      .map(([key, value]) => [normalizeMetadataKey(key), value]),
  );

  const renderToolContent = () => {

    if (tool === 'bash' || tool === 'shell' || tool === 'shell_command') {
      const command = getMeta('command') || getMeta('cmd') || getMeta('script');
      const description = getMeta('description');
      const workingDir = getMeta('cwd') || getMeta('working_directory') || getMeta('directory') || getMeta('path');
      const timeout = getMetaNum('timeout');
 
      return (
        <>
          {description && (
            <div className="typography-meta text-muted-foreground mb-2">{description}</div>
          )}
          {workingDir && (
            <div className="typography-meta text-muted-foreground mb-2">
              <span className="font-semibold">{t('chat.permissionCard.workingDirectory')}</span> <code className="px-1 py-0.5 bg-muted/30 rounded">{workingDir}</code>
            </div>
          )}
          {timeout && (
            <div className="typography-meta text-muted-foreground mb-2">
              <span className="font-semibold">{t('chat.permissionCard.timeout')}</span> {timeout}ms
            </div>
          )}
          {}
          {command && (
            <div>
              <WorkerHighlightedCode
                language="bash"
                code={command}
                style={PERMISSION_BASH_CUSTOM_STYLE}
                codeStyle={PERMISSION_BASH_CODE_TAG_PROPS.style}
                wrap
              />
            </div>
          )}
        </>
      );
    }

    if (tool === 'edit' || tool === 'multiedit' || tool === 'str_replace' || tool === 'str_replace_based_edit_tool') {
      const filePath = getMeta('path') || getMeta('file_path') || getMeta('filename') || getMeta('filePath');
      const changes = getMeta('changes') || getMeta('diff');
      const replaceAll = getMetaBool('replace_all') || getMetaBool('replaceAll');

      return (
        <>
          {replaceAll && (
            <div className="typography-meta text-muted-foreground mb-2">
              <span className="font-semibold">⚠️ {t('chat.permissionCard.replaceAll')}</span>
            </div>
          )}
          {changes && (
            <ScrollableOverlay outerClassName="max-h-[60vh]" className="tool-output-surface p-1 rounded-xl border border-border/20 bg-transparent">
              <DiffPreview diff={changes} filePath={filePath} />
            </ScrollableOverlay>
          )}
        </>
      );
    }

    if (tool === 'write' || tool === 'create' || tool === 'file_write') {
      const filePath = getMeta('path') || getMeta('file_path') || getMeta('filename') || getMeta('filePath');
      const content = getMeta('content') || getMeta('text') || getMeta('data');

      if (content) {
        return (
          <ScrollableOverlay outerClassName="max-h-[60vh]" className="tool-output-surface p-1 rounded-xl border border-border/20 bg-transparent">
            <WritePreview content={content} filePath={filePath} />
          </ScrollableOverlay>
        );
      }

      return null;
    }

    if (tool === 'webfetch' || tool === 'fetch' || tool === 'curl' || tool === 'wget') {
      const url = getMeta('url') || getMeta('uri') || getMeta('endpoint');
      const method = getMeta('method') || 'GET';
      const headers = permission.metadata.headers && typeof permission.metadata.headers === 'object' ? (permission.metadata.headers as Record<string, unknown>) : undefined;
      const body = permission.metadata.body ?? permission.metadata.data ?? permission.metadata.payload;
      const timeout = getMetaNum('timeout');
      const format = getMeta('format') || getMeta('responseType');

      return (
        <>
          {url && (
            <div className="mb-2">
              <div className="typography-meta text-muted-foreground mb-1">{t('chat.permissionCard.request')}</div>
              <div className="flex items-center gap-2">
                <span className="typography-meta font-semibold px-1.5 py-0.5 bg-primary/20 text-primary rounded">
                  {method}
                </span>
                <code className="typography-meta px-2 py-1 bg-muted/30 rounded flex-1 break-all">
                  {url}
                </code>
              </div>
            </div>
          )}
          {headers && Object.keys(headers).length > 0 && (
            <div className="mb-2">
              <div className="typography-meta text-muted-foreground mb-1">{t('chat.permissionCard.headers')}</div>
              <ScrollableOverlay outerClassName="max-h-32" className="p-0">
                <StructuredPermissionData data={headers} />
              </ScrollableOverlay>
            </div>
          )}
          {body && (
            <div className="mb-2">
              <div className="typography-meta text-muted-foreground mb-1">{t('chat.permissionCard.body')}</div>
              <ScrollableOverlay outerClassName="max-h-32" className="p-0">
                {typeof body === 'object' && body !== null ? (
                  <StructuredPermissionData data={body} />
                ) : (
                  <pre className="typography-meta font-mono px-2 py-1.5 bg-muted/20 border border-border/20 rounded-lg whitespace-pre-wrap break-all">
                    {String(body)}
                  </pre>
                )}
              </ScrollableOverlay>
            </div>
          )}
          {(timeout || format) && (
            <div className="typography-micro text-muted-foreground">
              {timeout && <span>{t('chat.permissionCard.timeout')} {timeout}ms</span>}
              {timeout && format && <span> • </span>}
              {format && <span>{t('chat.permissionCard.responseFormat')} {format}</span>}
            </div>
          )}
        </>
      );
    }

    if (Object.keys(displayMetadata).length === 0) return null;

    return (
      <div>
        <div className="typography-micro text-muted-foreground mb-1">{t('chat.permissionCard.details')}</div>
        <ScrollableOverlay outerClassName="max-h-48" className="p-0">
          <StructuredPermissionData data={displayMetadata} />
        </ScrollableOverlay>
      </div>
    );
  };

  return (
    <QuestionCardFrame
      mobile={isMobile}
      header={(
            <div className="flex min-w-0 items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
                <Icon name="question" className="h-3.5 w-3.5 text-[var(--status-warning)]" />
                <span className="truncate text-xs leading-4 sm:text-[length:var(--text-meta)] font-medium text-muted-foreground">
                  {t('sessions.sidebar.session.status.permissionRequired')}
                </span>
                {isFromSubagent ? (
                  <span className="hidden sm:inline typography-micro text-muted-foreground px-1.5 py-0.5 rounded bg-foreground/5">
                    {t('chat.questionCard.fromSubagent')}
                  </span>
                ) : null}
              </div>
              <div className="flex min-w-0 max-w-[48%] items-center gap-1.5">
                {getToolIcon(toolName)}
                <span className="truncate text-xs leading-4 sm:text-[length:var(--text-meta)] text-muted-foreground font-medium">{displayToolName}</span>
              </div>
            </div>
      )}
      footer={(
        <>
          <div className="grid w-full grid-cols-1 gap-1.5 sm:flex sm:items-center sm:flex-wrap">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => handleResponse('once')}
              disabled={isResponding}
              className="min-h-9 min-w-0 w-full gap-1.5 px-2 !text-xs leading-4 text-foreground sm:w-auto"
            >
              <Icon name="check" className="size-3.5 shrink-0 text-[var(--status-success)] sm:size-3" />
              <span className="truncate">{t('chat.permissionCard.allowOnce')}</span>
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => handleResponse('always')}
              disabled={isResponding}
              className="min-h-9 min-w-0 w-full gap-1.5 px-2 !text-xs leading-4 text-foreground sm:w-auto"
            >
              <Icon name="arrow-right" className="size-3.5 shrink-0 text-[var(--status-success)] sm:size-3" />
              <span className="truncate">{t('chat.permissionCard.alwaysAgree')}</span>
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => handleResponse('reject')}
              disabled={isResponding}
              className="min-h-9 min-w-0 w-full gap-1.5 px-2 !text-xs leading-4 text-[var(--status-error)] sm:w-auto"
            >
              <Icon name="close" className="size-3.5 shrink-0 sm:size-3" />
              <span className="truncate">{t('chat.permissionToast.actions.deny')}</span>
            </Button>
          </div>

          {isResponding ? (
            <div className="flex justify-center w-full py-1 sm:w-auto sm:ml-auto typography-meta text-muted-foreground">
              <div className="animate-spin h-3 w-3 border border-primary border-t-transparent rounded-full" />
            </div>
          ) : null}
        </>
      )}
    >
          <div className="[&_.typography-meta]:!text-xs [&_.typography-micro]:!text-[0.6875rem]">
            {permission.patterns.length > 0 && (
              <div className="mb-2">
                <div className="typography-micro text-muted-foreground mb-1">{t('chat.permissionCard.patterns')}</div>
                <div className="overflow-hidden rounded-lg border border-border/20 bg-muted/15">
                  {permission.patterns.map((pattern, index) => (
                    <code
                      key={`${pattern}-${index}`}
                      className={cn(
                        "block break-all px-2 py-1.5 text-xs leading-4 sm:text-[length:var(--text-meta)]",
                        index > 0 && "border-t border-border/15",
                      )}
                    >
                      {pattern}
                    </code>
                  ))}
                </div>
              </div>
            )}

            {renderToolContent()}
          </div>
    </QuestionCardFrame>
  );
};
