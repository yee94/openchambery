import type { SettingsPageSlug } from '@/lib/settings/metadata';
import type {
  DiffScope,
  ScheduleView,
  WorkspaceTab,
} from './pathContract';

/**
 * Semantic navigation intents.
 * Schedule / assistant are first-class (not session subtypes).
 */
export type NavigationIntent =
  | {
      type: 'session';
      sessionId: string;
      tab?: WorkspaceTab | string | null;
      file?: string | null;
      scope?: DiffScope | null;
      replace?: boolean;
    }
  | {
      type: 'schedule';
      scheduleView?: ScheduleView | null;
      scheduleProjectId?: string | null;
      scheduleTaskId?: string | null;
      focusSessionId?: string | null;
      replace?: boolean;
    }
  | {
      type: 'assistant';
      assistantId?: string | null;
      focusSessionId?: string | null;
      replace?: boolean;
    }
  | { type: 'new-session'; replace?: boolean }
  | {
      type: 'settings';
      slug?: SettingsPageSlug | string;
      entityId?: string | null;
      replace?: boolean;
    }
  | { type: 'close-settings'; replace?: boolean }
  | { type: 'connect'; replace?: boolean }
  | { type: 'back' };
