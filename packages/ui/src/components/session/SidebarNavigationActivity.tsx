import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryRuntime';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import type { GlobalScheduledTasksResponse } from '@/lib/scheduledTasksApi';
import { globalScheduledTasksQueryOptions, useAssistantWorking } from '@/queries/assistantQueries';
import { SessionBusyIndicator } from './SessionBusyIndicator';

const selectScheduledWorking = (snapshot: GlobalScheduledTasksResponse) => (
  snapshot.tasks.some(({ task }) => task.state.lastStatus === 'running')
);

export function ScheduledNavigationActivity() {
  const transport = getRuntimeTransportIdentity();
  const { data: working } = useQuery({
    ...globalScheduledTasksQueryOptions(transport),
    select: selectScheduledWorking,
    staleTime: 0,
    refetchInterval: (query) => query.state.data && selectScheduledWorking(query.state.data) ? 2_500 : 15_000,
    refetchIntervalInBackground: false,
  });
  useEffect(() => subscribeOpenchamberEvents((event) => {
    if (getRuntimeTransportIdentity() !== transport) return;
    if (event.type === 'scheduled-task-ran' || event.type === 'event-stream-ready') {
      void queryClient.invalidateQueries({ queryKey: globalScheduledTasksQueryOptions(transport).queryKey, exact: true });
    }
  }), [transport]);
  return working ? <SessionBusyIndicator className="ml-auto" /> : null;
}

export function AssistantNavigationActivity() {
  const working = useAssistantWorking();
  return working ? <SessionBusyIndicator /> : null;
}
