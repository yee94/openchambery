import { useAssistantWorking, useScheduledNavigationWorking } from '@/queries/assistantQueries';
import { SessionBusyIndicator } from './SessionBusyIndicator';

export function ScheduledNavigationActivity() {
  const working = useScheduledNavigationWorking();
  return working ? <SessionBusyIndicator className="ml-auto" /> : null;
}

export function AssistantNavigationActivity() {
  const working = useAssistantWorking();
  return working ? <SessionBusyIndicator /> : null;
}
