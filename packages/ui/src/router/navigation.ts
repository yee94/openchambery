import type { AppRouter } from './createAppRouter';
import {
  buildAssistantPath,
  buildConnectPath,
  buildNewSessionPath,
  buildSchedulePath,
  buildSessionPath,
  buildSettingsPath,
  normalizeSettingsSlug,
  type DiffScope,
  type ScheduleView,
  type WorkspaceTab,
} from './pathContract';
import type { NavigationIntent } from './navigationIntent';
import { SCHEDULE_TAB_ID } from './primarySurface';

export type GoSessionOptions = {
  tab?: WorkspaceTab | string | null;
  file?: string | null;
  scope?: DiffScope | null;
  replace?: boolean;
};

export type GoScheduleOptions = {
  scheduleView?: ScheduleView | null;
  scheduleProjectId?: string | null;
  scheduleTaskId?: string | null;
  focusSessionId?: string | null;
  replace?: boolean;
};

export type GoAssistantOptions = {
  assistantId?: string | null;
  focusSessionId?: string | null;
  replace?: boolean;
};

export type OpenSettingsOptions = {
  entityId?: string | null;
  replace?: boolean;
};

export type AppNavigation = {
  goSession: (sessionId: string, opts?: GoSessionOptions) => Promise<void>;
  goSchedule: (opts?: GoScheduleOptions) => Promise<void>;
  goAssistant: (opts?: GoAssistantOptions) => Promise<void>;
  goNewSession: (opts?: { replace?: boolean }) => Promise<void>;
  openSettings: (slug?: string, opts?: OpenSettingsOptions) => Promise<void>;
  closeSettings: (opts?: { replace?: boolean }) => Promise<void>;
  goConnect: (opts?: { replace?: boolean }) => Promise<void>;
  back: () => Promise<void>;
  applyIntent: (intent: NavigationIntent) => Promise<void>;
  getSettingsReturnTo: () => string;
};

async function navigateHref(
  router: AppRouter,
  target: { to: string; replace?: boolean },
): Promise<void> {
  await router.navigate({
    href: target.to,
    replace: target.replace,
  } as Parameters<AppRouter['navigate']>[0]);
}

export function createAppNavigation(router: AppRouter): AppNavigation {
  let settingsReturnTo = '/';

  const locationHref = () => {
    const { pathname, searchStr } = router.state.location;
    return `${pathname}${searchStr ?? ''}`;
  };

  const rememberWorkspaceIfNeeded = () => {
    const { pathname } = router.state.location;
    if (!pathname.startsWith('/settings')) {
      settingsReturnTo = locationHref();
    }
  };

  const goSchedule = async (opts: GoScheduleOptions = {}) => {
    await navigateHref(router, {
      to: buildSchedulePath(opts),
      replace: opts.replace,
    });
  };

  const goAssistant = async (opts: GoAssistantOptions = {}) => {
    await navigateHref(router, {
      to: buildAssistantPath(opts),
      replace: opts.replace,
    });
  };

  const goSession = async (sessionId: string, opts: GoSessionOptions = {}) => {
    const tab = opts.tab;
    if (tab === SCHEDULE_TAB_ID || tab === 'scheduled') {
      await goSchedule({ replace: opts.replace });
      return;
    }
    if (tab === 'assistant') {
      await goAssistant({ replace: opts.replace });
      return;
    }
    const path = buildSessionPath({
      sessionId,
      tab: opts.tab,
      file: opts.file,
      scope: opts.scope,
    });
    await navigateHref(router, { to: path, replace: opts.replace });
  };

  const goNewSession = async (opts: { replace?: boolean } = {}) => {
    await navigateHref(router, { to: buildNewSessionPath(), replace: opts.replace });
  };

  const openSettings = async (slug = 'home', opts: OpenSettingsOptions = {}) => {
    rememberWorkspaceIfNeeded();
    await navigateHref(router, {
      to: buildSettingsPath({
        slug: normalizeSettingsSlug(slug),
        entityId: opts.entityId ?? null,
      }),
      replace: opts.replace,
    });
  };

  const closeSettings = async (opts: { replace?: boolean } = {}) => {
    const target = settingsReturnTo || '/';
    await navigateHref(router, { to: target, replace: opts.replace ?? true });
  };

  const goConnect = async (opts: { replace?: boolean } = {}) => {
    await navigateHref(router, { to: buildConnectPath(), replace: opts.replace });
  };

  const back = async () => {
    router.history.back();
  };

  const applyIntent = async (intent: NavigationIntent) => {
    switch (intent.type) {
      case 'session':
        await goSession(intent.sessionId, {
          tab: intent.tab,
          file: intent.file,
          scope: intent.scope,
          replace: intent.replace,
        });
        return;
      case 'schedule':
        await goSchedule({
          scheduleView: intent.scheduleView,
          scheduleProjectId: intent.scheduleProjectId,
          scheduleTaskId: intent.scheduleTaskId,
          focusSessionId: intent.focusSessionId,
          replace: intent.replace,
        });
        return;
      case 'assistant':
        await goAssistant({
          assistantId: intent.assistantId,
          focusSessionId: intent.focusSessionId,
          replace: intent.replace,
        });
        return;
      case 'new-session':
        await goNewSession({ replace: intent.replace });
        return;
      case 'settings':
        await openSettings(intent.slug ?? 'home', {
          entityId: intent.entityId,
          replace: intent.replace,
        });
        return;
      case 'close-settings':
        await closeSettings({ replace: intent.replace });
        return;
      case 'connect':
        await goConnect({ replace: intent.replace });
        return;
      case 'back':
        await back();
        return;
      default: {
        const _exhaustive: never = intent;
        void _exhaustive;
      }
    }
  };

  return {
    goSession,
    goSchedule,
    goAssistant,
    goNewSession,
    openSettings,
    closeSettings,
    goConnect,
    back,
    applyIntent,
    getSettingsReturnTo: () => settingsReturnTo,
  };
}
