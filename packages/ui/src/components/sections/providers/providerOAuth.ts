import type { IntegrationAttempt } from '@opencode/client';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeGeneration } from '@/lib/runtime-switch';

/** One UI-owned attempt. Runtime changes retire it locally; the old server expires it. */
export function createProviderOAuthFlow(options: {
  integrationID: string;
  onAttempt: (attempt: IntegrationAttempt) => void;
  onSuccess: () => Promise<void>;
  onError: (phase: 'start' | 'complete') => void;
}) {
  const sdk = opencodeClient.getSdkClient();
  const generation = getRuntimeGeneration();
  const directory = opencodeClient.getDirectory();
  const location = directory ? { directory } : undefined;
  const controller = new AbortController();
  let attempt: IntegrationAttempt | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let submitting = false;
  let finished = false;
  let cancelledRemotely = false;
  const current = () => !controller.signal.aborted
    && generation === getRuntimeGeneration()
    && directory === opencodeClient.getDirectory();
  const clear = () => { clearTimeout(timer); clearTimeout(deadline); };
  const cancelRemote = () => {
    if (attempt && !finished && !cancelledRemotely && generation === getRuntimeGeneration()) {
      cancelledRemotely = true;
      void sdk.integration.oauth.cancel({ integrationID: options.integrationID, attemptID: attempt.attemptID, location }).catch(() => undefined);
    }
  };
  const cancel = () => { controller.abort(); clear(); cancelRemote(); };
  const fail = (phase: 'start' | 'complete') => {
    if (!current()) return;
    cancel();
    options.onError(phase);
  };
  const succeed = async () => {
    if (!current()) return;
    finished = true;
    clear();
    await options.onSuccess();
  };
  const poll = async () => {
    if (!current() || !attempt) return;
    try {
      const result = await sdk.integration.oauth.status({ integrationID: options.integrationID, attemptID: attempt.attemptID, location }, { signal: controller.signal });
      if (!current()) return;
      if (result.data.status === 'complete') { await succeed(); return; }
      if (result.data.status !== 'pending') { fail('complete'); return; }
      timer = setTimeout(() => { void poll(); }, 1500);
    } catch { fail('complete'); }
  };
  return {
    cancel,
    isCurrent: current,
    async start(methodID: string) {
      deadline = setTimeout(() => fail('start'), 30_000);
      try {
        const result = await sdk.integration.oauth.connect({ integrationID: options.integrationID, methodID, location }, { signal: controller.signal });
        attempt = result.data;
        if (!current()) { cancelRemote(); return; }
        clearTimeout(deadline);
        if (!attempt.attemptID || !['auto', 'code'].includes(attempt.mode)) { fail('start'); return; }
        const remaining = Math.min(10 * 60_000, (attempt.time?.expires ?? Date.now() + 10 * 60_000) - Date.now());
        if (remaining <= 0) { fail('complete'); return; }
        deadline = setTimeout(() => fail('complete'), remaining);
        options.onAttempt(attempt);
        if (attempt.mode === 'auto') void poll();
      } catch { fail('start'); }
    },
    async complete(code: string) {
      if (!current() || !attempt || attempt.mode !== 'code' || submitting || !code.trim()) return;
      submitting = true;
      try {
        await sdk.integration.oauth.complete({ integrationID: options.integrationID, attemptID: attempt.attemptID, code: code.trim(), location }, { signal: controller.signal });
        await succeed();
      } catch { fail('complete'); }
    },
  };
}
