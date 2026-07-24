import type { PendingUserMessagePresentation } from '@/sync/session-ui-store';
import type { SessionBinding } from '@/queries/assistantQueries';

const DEFAULT_REFRESH_DELAYS_MS = [0, 500, 1_500, 4_000] as const;

export const rebindPendingAssistantMessage = (
  messages: readonly PendingUserMessagePresentation[],
  messageID: string,
  sessionID: string,
): PendingUserMessagePresentation[] => {
  let changed = false;
  const next = messages.map((message) => {
    if (message.info.id !== messageID || message.info.sessionID === sessionID) return message;
    changed = true;
    return { ...message, info: { ...message.info, sessionID } };
  });
  return changed ? next : messages as PendingUserMessagePresentation[];
};

export const reconcileAdmittedAssistantBinding = (input: {
  binding: SessionBinding;
  refresh: (binding: SessionBinding) => Promise<void>;
  isCurrent: () => boolean;
  refreshDelaysMs?: readonly number[];
  sleep?: (delayMs: number) => Promise<void>;
}): void => {
  const refreshDelaysMs = input.refreshDelaysMs ?? DEFAULT_REFRESH_DELAYS_MS;
  const sleep = input.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  void (async () => {
    for (const delayMs of refreshDelaysMs) {
      if (delayMs > 0) await sleep(delayMs);
      if (!input.isCurrent()) return;
      try {
        await input.refresh(input.binding);
        break;
      } catch {
        // Admission is already durable. Materialization retries stay in the background.
      }
    }
  })();
};
