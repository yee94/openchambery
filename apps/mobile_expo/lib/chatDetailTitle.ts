/**
 * Cap MobileChatScreen / MobileHeader title + subtitle resolution for Expo ChatDetailHeader.
 *
 * Title order (non-draft): preferredTitle → session.title → assistant display name → untitled.
 * Draft: preferredTitle → draftLabel (sensible "新会话" / New session).
 * Subtitle: sync hint wins; else `项目 · 分支` (formatHomeSessionSubtitle).
 */
import { getAssistantPresentation } from '@/lib/assistantPresentation';
import {
  formatHomeSessionSubtitle,
  normalizePath,
  projectLabelFromDirectory,
} from '@/lib/sessionHomeModel';

export type ChatDetailTitleSource = {
  isDraft: boolean;
  /** Explicit override (e.g. route-passed or assistant display name). */
  preferredTitle?: string | null;
  sessionTitle?: string | null;
  assistantName?: string | null;
  draftLabel: string;
  untitledLabel: string;
};

export type ChatDetailSubtitleSource = {
  syncHint?: string | null;
  directory?: string | null;
  branch?: string | null;
  projectLabel?: string | null;
  /** When directory is empty, omit subtitle rather than inventing a project. */
  noProjectLabel?: string | null;
};

export type ChatDetailHeaderLabels = {
  title: string;
  subtitle: string | null;
};

const trimOrEmpty = (value?: string | null): string =>
  typeof value === 'string' ? value.trim() : '';

/** Cap MobileChatScreen resolvedTitle (+ assistantName fallback for assistant-bound rows). */
export const resolveChatDetailTitle = (source: ChatDetailTitleSource): string => {
  const preferred = trimOrEmpty(source.preferredTitle);
  if (source.isDraft) {
    return preferred || source.draftLabel;
  }
  if (preferred) return preferred;
  const sessionTitle = trimOrEmpty(source.sessionTitle);
  if (sessionTitle) return sessionTitle;
  const assistantRaw = trimOrEmpty(source.assistantName);
  if (assistantRaw) {
    const display = getAssistantPresentation(assistantRaw).displayName.trim();
    if (display) return display;
  }
  return source.untitledLabel;
};

/**
 * Cap: sync whisper under the title when chasing remote transcript;
 * Expo IA: otherwise show `项目 · 分支` (not a second title).
 */
export const resolveChatDetailSubtitle = (source: ChatDetailSubtitleSource): string | null => {
  const syncHint = trimOrEmpty(source.syncHint);
  if (syncHint) return syncHint;

  const explicitProject = trimOrEmpty(source.projectLabel);
  const directory = normalizePath(trimOrEmpty(source.directory));
  const fromPath = projectLabelFromDirectory(directory);
  const projectLabel = explicitProject || fromPath || directory;

  if (!trimOrEmpty(projectLabel)) {
    const fallback = trimOrEmpty(source.noProjectLabel);
    return fallback || null;
  }

  return formatHomeSessionSubtitle(projectLabel, source.branch);
};

/** Cap resolveMobileTranscriptSyncHint — Expo cold load / reconnect whisper (no Cap flight registries). */
export const resolveExpoChatSyncHintKind = (input: {
  sessionId: string;
  hasTranscript: boolean;
  loadStatus: 'idle' | 'loading' | 'ready' | 'error';
}): 'syncing' | null => {
  if (!input.sessionId) return null;
  if (input.hasTranscript) return null;
  if (input.loadStatus === 'loading') return 'syncing';
  return null;
};



/** Live header fields carried by Cap `session.updated` / `session.created` (`properties.info`). */
export type ChatDetailSessionMeta = {
  title?: string;
  assistantName?: string | null;
  directory?: string | null;
  branch?: string | null;
  /** Cap `session.time.updated` — skip stale SSE echoes after a newer rename. */
  updatedAt?: number;
};

export type SessionEventLike = {
  type: string;
  properties?: Record<string, unknown> | null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Cap session-event-router subset: pull id + title/subtitle fields from
 * `session.updated` / `session.created` so ChatDetailHeader can refresh without re-open.
 */
export const extractChatDetailSessionMetaFromEvent = (
  event: SessionEventLike,
): (ChatDetailSessionMeta & { id: string }) | null => {
  if (event.type !== 'session.updated' && event.type !== 'session.created') return null;
  const info = asRecord(event.properties?.info);
  if (!info) return null;
  const id = typeof info.id === 'string' ? info.id.trim() : '';
  if (!id) return null;

  const project = asRecord(info.project);
  const time = asRecord(info.time);
  const updatedAt = typeof time?.updated === 'number' ? time.updated : undefined;
  const branchFromSession = typeof info.branch === 'string' ? info.branch : undefined;
  const branchFromProject = typeof project?.branch === 'string' ? project.branch : undefined;

  return {
    id,
    title: typeof info.title === 'string' ? info.title : undefined,
    assistantName: typeof info.assistantName === 'string' ? info.assistantName : undefined,
    directory: typeof info.directory === 'string' ? info.directory : undefined,
    branch: branchFromSession ?? branchFromProject,
    updatedAt,
  };
};

/** Merge live session.updated patch onto Chat header meta (keeps Cap title order inputs fresh). */
export const mergeChatDetailSessionMeta = (
  prev: ChatDetailSessionMeta | null | undefined,
  patch: ChatDetailSessionMeta,
): ChatDetailSessionMeta => {
  if (
    typeof prev?.updatedAt === 'number' &&
    typeof patch.updatedAt === 'number' &&
    patch.updatedAt < prev.updatedAt
  ) {
    return prev;
  }
  const next: ChatDetailSessionMeta = { ...(prev ?? {}) };
  if (typeof patch.title === 'string') next.title = patch.title;
  if (patch.assistantName !== undefined) next.assistantName = patch.assistantName;
  if (patch.directory !== undefined) next.directory = patch.directory;
  if (patch.branch !== undefined) next.branch = patch.branch;
  if (typeof patch.updatedAt === 'number') next.updatedAt = patch.updatedAt;
  return next;
};

export const buildChatDetailHeaderLabels = (
  titleSource: ChatDetailTitleSource,
  subtitleSource: ChatDetailSubtitleSource,
): ChatDetailHeaderLabels => ({
  title: resolveChatDetailTitle(titleSource),
  subtitle: resolveChatDetailSubtitle(subtitleSource),
});
