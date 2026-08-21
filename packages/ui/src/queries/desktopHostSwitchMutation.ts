import { MutationObserver, useIsMutating, useMutationState } from '@tanstack/react-query';
import { toast } from '@/components/ui';
import {
  isDesktopHostActive,
  runtimeKeyForDesktopHost,
  switchDesktopHost,
  switchViaSshRelay,
  type DesktopHostProbeSnapshot,
  type SwitchDesktopHostResult,
} from '@/lib/desktopHostSwitch';
import type { DesktopHost } from '@/lib/desktopHosts';
import { redactSensitiveUrl } from '@/lib/desktopHosts';
import { formatMessage, useI18nStore, type I18nKey, type I18nParams } from '@/lib/i18n';
import { queryClient } from '@/lib/queryRuntime';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';

/** Stable mutation key — all desktop host switches share one global pending lane. */
export const DESKTOP_HOST_SWITCH_MUTATION_KEY = ['desktopHostSwitch'] as const;

export type SwitchDesktopHostInstanceVariables = {
  host: DesktopHost;
  cachedProbe?: DesktopHostProbeSnapshot | null;
  /**
   * Local host only: API origin + client token. Remote hosts use the host record.
   * When omitted for local, the call is a no-op failure.
   */
  localApiOrigin?: string | null;
  localClientToken?: string | null;
};

export class DesktopHostSwitchError extends Error {
  readonly result: Extract<SwitchDesktopHostResult, { ok: false }>;
  readonly host: DesktopHost;

  constructor(result: Extract<SwitchDesktopHostResult, { ok: false }>, host: DesktopHost) {
    super(result.reason);
    this.name = 'DesktopHostSwitchError';
    this.result = result;
    this.host = host;
  }
}

const t = (key: I18nKey, params?: I18nParams): string => {
  return formatMessage(useI18nStore.getState().dictionary, key, params);
};

const mutationFn = async (
  variables: SwitchDesktopHostInstanceVariables,
): Promise<SwitchDesktopHostResult> => {
  const { host } = variables;

  if (host.id === 'local') {
    const apiOrigin = (variables.localApiOrigin || '').trim();
    if (!apiOrigin) {
      throw new DesktopHostSwitchError(
        { ok: false, status: { status: 'unreachable', latencyMs: 0 }, reason: 'unreachable' },
        host,
      );
    }
    switchRuntimeEndpoint({
      apiBaseUrl: apiOrigin,
      clientToken: variables.localClientToken || null,
      runtimeKey: runtimeKeyForDesktopHost(host),
    });
    return { ok: true, via: 'direct', status: { status: 'ok', latencyMs: 0 } };
  }

  // Mobile/browser over relay: keep the tunnel, retarget with SSH host token + port.
  if (host.viaSshRelay) {
    const result = await switchViaSshRelay(host);
    if (!result.ok) {
      throw new DesktopHostSwitchError(result, host);
    }
    return result;
  }

  const result = await switchDesktopHost(host, { cachedProbe: variables.cachedProbe });
  if (!result.ok) {
    throw new DesktopHostSwitchError(result, host);
  }
  return result;
};

type SwitchObserver = MutationObserver<
  SwitchDesktopHostResult,
  DesktopHostSwitchError,
  SwitchDesktopHostInstanceVariables
>;

let switchObserver: SwitchObserver | null = null;
let switchObserverUnsubscribe: (() => void) | null = null;

const getSwitchObserver = (): SwitchObserver => {
  if (switchObserver) return switchObserver;

  switchObserver = new MutationObserver(queryClient, {
    mutationKey: DESKTOP_HOST_SWITCH_MUTATION_KEY,
    mutationFn,
    onError: (error, variables) => {
      if (!(error instanceof DesktopHostSwitchError)) return;
      if (error.result.reason === 'unsupported') return;
      toast.error(t('desktopHostSwitcher.toast.instanceUnreachable', {
        host: redactSensitiveUrl(variables.host.label),
      }));
    },
  });
  // Keep the observer alive so mutate() always has an active subscriber.
  switchObserverUnsubscribe = switchObserver.subscribe(() => undefined);
  return switchObserver;
};

/** Imperative global entry: one call starts the switch + shared pending/overlay lane. */
export const switchDesktopHostInstance = async (
  variables: SwitchDesktopHostInstanceVariables,
): Promise<SwitchDesktopHostResult> => {
  if (isDesktopHostActive(variables.host)) {
    return {
      ok: true,
      via: 'direct',
      status: variables.cachedProbe?.status === 'ok'
        ? variables.cachedProbe
        : { status: 'ok', latencyMs: 0 },
    };
  }

  if (queryClient.isMutating({ mutationKey: DESKTOP_HOST_SWITCH_MUTATION_KEY }) > 0) {
    // Another switch is already in flight — refuse instead of queueing a second
    // full-screen transition (callers only need one active switch at a time).
    return {
      ok: false,
      status: { status: 'unreachable', latencyMs: 0 },
      reason: 'unsupported',
    };
  }

  try {
    return await getSwitchObserver().mutate(variables);
  } catch (error) {
    if (error instanceof DesktopHostSwitchError) {
      return error.result;
    }
    throw error;
  }
};

/** Non-React pending check (e.g. button guards outside hooks). */
export const isDesktopHostSwitchPending = (): boolean => {
  return queryClient.isMutating({ mutationKey: DESKTOP_HOST_SWITCH_MUTATION_KEY }) > 0;
};

/** React: true while any desktop host switch mutation is in flight. */
export const useDesktopHostSwitchPending = (): boolean => {
  return useIsMutating({ mutationKey: DESKTOP_HOST_SWITCH_MUTATION_KEY }) > 0;
};

/** React: host id currently being switched, or null. */
export const useDesktopHostSwitchingHostId = (): string | null => {
  const pending = useMutationState({
    filters: { mutationKey: DESKTOP_HOST_SWITCH_MUTATION_KEY, status: 'pending' },
    select: (mutation) => mutation.state.variables as SwitchDesktopHostInstanceVariables | undefined,
  });
  return pending[0]?.host.id ?? null;
};

/** Test helper: drop the singleton observer between cases. */
export const resetDesktopHostSwitchMutationForTests = (): void => {
  switchObserverUnsubscribe?.();
  switchObserverUnsubscribe = null;
  switchObserver = null;
  queryClient.getMutationCache().clear();
};
