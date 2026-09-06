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

export const buildChatDetailHeaderLabels = (
  titleSource: ChatDetailTitleSource,
  subtitleSource: ChatDetailSubtitleSource,
): ChatDetailHeaderLabels => ({
  title: resolveChatDetailTitle(titleSource),
  subtitle: resolveChatDetailSubtitle(subtitleSource),
});
