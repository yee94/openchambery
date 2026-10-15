import React from 'react';
import { useEvent } from '@reactuses/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n';
import { useDirectoryStore, useRunningSessions } from '@/sync/sync-context';
import { useTranscriptProjection } from '@/sync/transcript-repository-observers';
import { abortCurrentOperation } from '@/sync/session-actions';
import { opencodeClient } from '@/lib/opencode/client';
import { useUIStore } from '@/stores/useUIStore';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { backgroundShellOutputQueryOptions, backgroundShellQueryOptions, useBackgroundShells } from '@/queries/backgroundShellQueries';
import { AgentAvatar } from './AgentAvatar';
import ToolPart from './message/parts/ToolPart';
import { SessionSurfaceContext, useSessionSurface } from './SessionSurfaceContext';
import { projectBackgroundTasks, sameBackgroundTasks, type BackgroundTask } from './backgroundTaskProjection';

const BackgroundTaskRow = ({ task, directory }: { task: BackgroundTask; directory: string }) => {
    const { t } = useI18n();
    const surface = useSessionSurface();
    const isMobile = useUIStore((state) => state.isMobile);
    const client = useQueryClient();
    const [expanded, setExpanded] = React.useState(false);
    const [stopping, setStopping] = React.useState(false);
    const stopInFlight = React.useRef(false);
    const output = useQuery({
        ...backgroundShellOutputQueryOptions(directory, task.id),
        enabled: task.type === 'shell' && expanded,
        refetchInterval: task.type === 'shell' && expanded ? 3_000 : false,
    });
    const stop = useEvent(async () => {
        if (!surface.capabilities.mutateSession || !surface.active || stopInFlight.current) return;
        stopInFlight.current = true;
        setStopping(true);
        const scope = backgroundShellQueryOptions(directory, []);
        try {
            if (task.type === 'subagent') await abortCurrentOperation(task.id);
            else {
                await opencodeClient.getScopedSdkClient(directory).shell.remove({ id: task.id, location: { directory } });
                await client.invalidateQueries({ queryKey: scope.queryKey.slice(0, 3) });
            }
        } catch {
            toast.error(t('chat.chatInput.stopUnconfirmed'));
        } finally {
            stopInFlight.current = false;
            setStopping(false);
        }
    });
    const part = task.type === 'shell' && output.data
        ? { ...task.part, state: { ...task.part.state, output: output.data.output } }
        : task.part;
    return (
        <div className="flex min-w-0 items-start gap-2" data-background-task={task.id}>
            <div className="min-w-0 flex-1">
                <ToolPart part={part} messageId={task.part.messageID} isExpanded={expanded}
                    onToggle={() => setExpanded((value) => !value)} isMobile={isMobile} animateTailText={false} />
                {task.type === 'shell' && expanded && output.isError ? (
                    <Button variant="ghost" size="sm" onClick={() => void output.refetch()}>
                        {t('chat.activity.outputLoadFailed')} · {t('chat.activity.outputRetry')}
                    </Button>
                ) : null}
                {task.type === 'shell' && expanded && output.data?.truncated ? (
                    <p className="typography-meta text-muted-foreground">{t('chat.sessionBackground.outputTruncated')}</p>
                ) : null}
            </div>
            {surface.active && surface.capabilities.mutateSession ? (
                <Button variant="ghost" size="icon" disabled={stopping} onClick={() => void stop()}
                    aria-label={t('mobile.sessions.stopSessionAria', { title: task.label })}>
                    <Icon name="stop-circle" className="size-4" />
                </Button>
            ) : null}
        </div>
    );
};

export const BackgroundWorkHint = React.memo(({ sessionID, directory }: { sessionID: string; directory: string }) => {
    const { t } = useI18n();
    const surface = useSessionSurface();
    const taskSurface = React.useMemo(() => ({ ...surface, sessionId: sessionID, directory }), [surface, sessionID, directory]);
    const store = useDirectoryStore(directory, { bootstrap: false });
    const candidates = useTranscriptProjection(sessionID, directory, store, projectBackgroundTasks, sameBackgroundTasks,
        { enabled: Boolean(sessionID && directory) });
    const childIDs = React.useMemo(() => candidates.filter((task) => task.type === 'subagent').map((task) => task.id), [candidates]);
    const shellIDs = React.useMemo(() => candidates.filter((task) => task.type === 'shell').map((task) => task.id), [candidates]);
    const runningChildren = useRunningSessions(childIDs);
    const shells = useBackgroundShells(directory, shellIDs);
    const tasks = React.useMemo(() => {
        const childSet = new Set(runningChildren);
        const shellSet = new Set(shells.data?.filter((shell) => shell.status === 'running' && shell.metadata.sessionID === sessionID).map((shell) => shell.id));
        return candidates.filter((task) => task.type === 'subagent' ? childSet.has(task.id) : shellSet.has(task.id));
    }, [candidates, runningChildren, shells.data, sessionID]);
    if (tasks.length === 0 && !shells.isError) return null;
    return (
        <div className="chat-column py-1 typography-meta text-muted-foreground" role="status" aria-live="polite">
            {tasks.length > 0 ? (
                <Collapsible key={`${directory}:${sessionID}`}>
                    <CollapsibleTrigger asChild>
                        <Button variant="ghost" size="sm" className="w-auto justify-start gap-2 px-0 text-muted-foreground">
                            <span>{t('chat.sessionBackground.tasksRunning', { count: tasks.length })}</span>
                            <span className="inline-flex items-center gap-1" aria-hidden="true">
                                {tasks.filter((task) => task.type === 'subagent').slice(0, 3).map((task) => (
                                    <AgentAvatar key={task.id} name={task.agent} size={14} />
                                ))}
                            </span>
                            <Icon name="arrow-down-s" className="size-3.5" />
                        </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="space-y-1 pt-1">
                        <SessionSurfaceContext.Provider value={taskSurface}>
                            {tasks.map((task) => <BackgroundTaskRow key={`${task.type}:${task.id}`} task={task} directory={directory} />)}
                        </SessionSurfaceContext.Provider>
                    </CollapsibleContent>
                </Collapsible>
            ) : null}
            {shells.isError ? <Button variant="ghost" size="sm" onClick={() => void shells.refetch()}>
                {t('chat.activity.outputLoadFailed')} · {t('chat.activity.outputRetry')}
            </Button> : null}
        </div>
    );
});

BackgroundWorkHint.displayName = 'BackgroundWorkHint';
