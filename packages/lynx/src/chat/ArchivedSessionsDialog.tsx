/**
 * Cap ArchivedSessionsDialog for Lynx — browse archived by project, restore/preview.
 * Sheet overlay (mobile Cap MobileOverlayPanel spirit). Real Cap list + unarchive only.
 */
import { useEffect, useMemo, useState } from 'react';

import { lynxT } from '../i18n/catalog';
import { LynxScrollView, LynxText, LynxView } from '../lynx-elements';
import { unarchiveLynxSession } from '../projects/sessionActions';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import type { SessionIndexState } from '../session-index/types';
import { LynxMobileResizableSheet } from '../shell/MobileResizableSheet';
import { cssVar } from '../theme/tokens';
import {
  buildLynxArchivedSessionsModel,
  formatLynxArchivedSessionCount,
  listLynxArchivedSessions,
  type LynxArchivedProjectBucket,
  type LynxArchivedSessionRow,
} from './archivedSessions';

export type LynxArchivedSessionsDialogProps = {
  locale: string;
  open: boolean;
  onClose: () => void;
  indexState?: SessionIndexState | null;
  runtimeFetch?: LynxRuntimeFetch | null;
  onSelectSession?: (sessionId: string, directory: string | null) => void;
  onMutated?: () => void;
};

const formatActivity = (activityAt: number): string | null => {
  if (!(activityAt > 0)) return null;
  try {
    return new Date(activityAt).toLocaleDateString();
  } catch {
    return null;
  }
};

export function LynxArchivedSessionsDialog({
  locale,
  open,
  onClose,
  indexState = null,
  runtimeFetch = null,
  onSelectSession,
  onMutated,
}: LynxArchivedSessionsDialogProps) {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<LynxArchivedSessionRow[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setSelectedProjectId(null);
      setRestoringId(null);
      setActionError(null);
      setNote(null);
      setLoadError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      const result = await listLynxArchivedSessions(runtimeFetch, {
        untitledLabel: lynxT(locale, 'lynx.chat.archived.untitled'),
      });
      if (cancelled) return;
      setLoading(false);
      if (result.status === 'ok') {
        setSessions(result.sessions);
        return;
      }
      setSessions([]);
      if (result.status === 'no-runtime') {
        setLoadError(lynxT(locale, 'lynx.chat.archived.noRuntime'));
        return;
      }
      setLoadError(result.error || lynxT(locale, 'lynx.chat.archived.loadFailed'));
    })();
    return () => {
      cancelled = true;
    };
  }, [open, runtimeFetch, locale]);

  const model = useMemo(() => buildLynxArchivedSessionsModel({
    sessions,
    snapshot: indexState?.snapshot ?? null,
    otherLabel: lynxT(locale, 'lynx.chat.archived.otherProjects'),
  }), [sessions, indexState?.snapshot, locale]);

  const selectedBucket: LynxArchivedProjectBucket | null = selectedProjectId
    ? model.buckets.find((bucket) => bucket.projectId === selectedProjectId) ?? null
    : null;

  const headerTitle = selectedBucket
    ? selectedBucket.label
    : lynxT(locale, 'lynx.chat.archived.title');

  const sessionCountLabel = (count: number) => formatLynxArchivedSessionCount(
    count,
    lynxT(locale, 'lynx.chat.archived.sessionSingular'),
    lynxT(locale, 'lynx.chat.archived.sessionPlural'),
  );

  const headerDescription = selectedBucket
    ? sessionCountLabel(selectedBucket.sessions.length)
    : lynxT(locale, 'lynx.chat.archived.description');

  const handleRestore = (session: LynxArchivedSessionRow) => {
    if (restoringId) return;
    setRestoringId(session.id);
    setActionError(null);
    void (async () => {
      const result = await unarchiveLynxSession(runtimeFetch, {
        sessionId: session.id,
        directory: session.directory,
      });
      setRestoringId(null);
      if (result.status !== 'ok') {
        setActionError(
          result.status === 'no-runtime'
            ? lynxT(locale, 'lynx.chat.archived.noRuntime')
            : (result.error || lynxT(locale, 'lynx.chat.archived.restoreFailed')),
        );
        return;
      }
      setSessions((current) => current.filter((row) => row.id !== session.id));
      setNote(lynxT(locale, 'lynx.chat.archived.restored'));
      onMutated?.();
    })();
  };

  const handlePreview = (session: LynxArchivedSessionRow) => {
    onSelectSession?.(session.id, session.directory);
    onClose();
  };

  return (
    <LynxMobileResizableSheet
      locale={locale}
      open={open}
      title={headerTitle}
      ariaLabel={lynxT(locale, 'lynx.chat.archived.aria')}
      onClose={onClose}
      initiallyExpanded
    >
      <LynxView data-lynx-archived-sessions="body" style={{ flexGrow: 1, minHeight: '0', display: 'flex', flexDirection: 'column' }}>
        <LynxText style={{ marginBottom: '8px', color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
          {headerDescription}
        </LynxText>

        {selectedBucket ? (
          <LynxView
            data-lynx-archived-sessions-back="true"
            bindtap={() => setSelectedProjectId(null)}
            accessibility-role="button"
            accessibility-label={lynxT(locale, 'lynx.chat.archived.backToProjects')}
            style={{ marginBottom: '8px' }}
          >
            <LynxText style={{ color: cssVar('primary.base'), fontSize: '13px' }}>
              ← {lynxT(locale, 'lynx.chat.archived.backToProjects')}
            </LynxText>
          </LynxView>
        ) : null}

        {note ? (
          <LynxText style={{ marginBottom: '6px', color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
            {note}
          </LynxText>
        ) : null}
        {actionError ? (
          <LynxText style={{ marginBottom: '6px', color: cssVar('status.error'), fontSize: '12px' }}>
            {actionError}
          </LynxText>
        ) : null}
        {loadError ? (
          <LynxText style={{ marginBottom: '6px', color: cssVar('status.error'), fontSize: '12px' }}>
            {loadError}
          </LynxText>
        ) : null}

        <LynxScrollView style={{ flexGrow: 1, minHeight: '0' }}>
          {loading ? (
            <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
              {lynxT(locale, 'lynx.chat.archived.loading')}
            </LynxText>
          ) : null}

          {!loading && !selectedBucket && model.empty && !loadError ? (
            <LynxView
              data-lynx-archived-sessions-empty="true"
              style={{
                padding: '16px',
                borderRadius: '12px',
                borderWidth: '1px',
                borderColor: cssVar('surface.mutedForeground'),
                borderStyle: 'dashed',
              }}
            >
              <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '13px' }}>
                {lynxT(locale, 'lynx.chat.archived.empty')}
              </LynxText>
            </LynxView>
          ) : null}

          {!loading && !selectedBucket
            ? model.buckets.map((bucket) => (
              <LynxView
                key={bucket.projectId}
                data-lynx-archived-sessions-bucket={bucket.projectId}
                bindtap={() => setSelectedProjectId(bucket.projectId)}
                accessibility-role="button"
                accessibility-label={bucket.label}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  marginBottom: '8px',
                  padding: '12px',
                  borderRadius: '12px',
                  borderWidth: '1px',
                  borderColor: cssVar('surface.mutedForeground'),
                  backgroundColor: cssVar('surface.muted'),
                }}
              >
                <LynxView style={{ flexGrow: 1, minWidth: '0' }}>
                  <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '14px', fontWeight: '600' }}>
                    {bucket.label}
                  </LynxText>
                  {bucket.path ? (
                    <LynxText style={{ marginTop: '2px', color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
                      {bucket.path}
                    </LynxText>
                  ) : null}
                </LynxView>
                <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginRight: '6px' }}>
                  {sessionCountLabel(bucket.sessions.length)}
                </LynxText>
                <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '14px' }}>›</LynxText>
              </LynxView>
            ))
            : null}

          {!loading && selectedBucket && selectedBucket.sessions.length === 0 ? (
            <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
              {lynxT(locale, 'lynx.chat.archived.emptyProject')}
            </LynxText>
          ) : null}

          {!loading && selectedBucket
            ? selectedBucket.sessions.map((session) => {
              const busy = restoringId === session.id;
              const activity = formatActivity(session.activityAt);
              return (
                <LynxView
                  key={session.id}
                  data-lynx-archived-sessions-row={session.id}
                  style={{
                    marginBottom: '8px',
                    padding: '12px',
                    borderRadius: '12px',
                    borderWidth: '1px',
                    borderColor: cssVar('surface.mutedForeground'),
                    backgroundColor: cssVar('surface.muted'),
                  }}
                >
                  <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '14px', fontWeight: '600' }}>
                    {session.title}
                  </LynxText>
                  <LynxText style={{ marginTop: '2px', color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
                    {[activity, session.directory].filter(Boolean).join(' · ')}
                  </LynxText>
                  <LynxView style={{ flexDirection: 'row', marginTop: '10px', gap: '8px' }}>
                    <LynxView
                      data-lynx-archived-sessions-preview={session.id}
                      bindtap={() => handlePreview(session)}
                      accessibility-role="button"
                      accessibility-label={lynxT(locale, 'lynx.chat.archived.preview')}
                      style={{
                        paddingLeft: '10px',
                        paddingRight: '10px',
                        paddingTop: '6px',
                        paddingBottom: '6px',
                        borderRadius: '8px',
                        borderWidth: '1px',
                        borderColor: cssVar('surface.mutedForeground'),
                        opacity: busy ? 0.5 : 1,
                      }}
                    >
                      <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '12px' }}>
                        {lynxT(locale, 'lynx.chat.archived.preview')}
                      </LynxText>
                    </LynxView>
                    <LynxView
                      data-lynx-archived-sessions-restore={session.id}
                      bindtap={() => handleRestore(session)}
                      accessibility-role="button"
                      accessibility-label={lynxT(locale, 'lynx.chat.archived.restore')}
                      style={{
                        paddingLeft: '10px',
                        paddingRight: '10px',
                        paddingTop: '6px',
                        paddingBottom: '6px',
                        borderRadius: '8px',
                        backgroundColor: cssVar('primary.base'),
                        opacity: busy ? 0.5 : 1,
                      }}
                    >
                      <LynxText style={{ color: cssVar('primary.foreground'), fontSize: '12px', fontWeight: '700' }}>
                        {busy
                          ? lynxT(locale, 'lynx.chat.archived.restoring')
                          : lynxT(locale, 'lynx.chat.archived.restore')}
                      </LynxText>
                    </LynxView>
                  </LynxView>
                </LynxView>
              );
            })
            : null}

          {!loading && !selectedBucket && model.total > 0 ? (
            <LynxText style={{ marginTop: '4px', color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
              {formatLynxArchivedSessionCount(
                model.total,
                lynxT(locale, 'lynx.chat.archived.summarySingular'),
                lynxT(locale, 'lynx.chat.archived.summaryPlural'),
              )}
            </LynxText>
          ) : null}
        </LynxScrollView>
      </LynxView>
    </LynxMobileResizableSheet>
  );
}
