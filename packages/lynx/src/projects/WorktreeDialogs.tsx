/**
 * Shared Cap NewWorktree + MobileDeleteWorktreeDialog spirit for Lynx.
 * Used by ProjectsHome + SessionsSheet so create/delete stay consistent.
 */
import { useEffect, useMemo, useState } from 'react';

import { lynxT } from '../i18n/catalog';
import { LynxInput, LynxText, LynxView } from '../lynx-elements';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { cssVar } from '../theme/tokens';
import { LynxCenteredDialog, LynxCenteredDialogAction } from '../shell/CenteredDialog';
import { LynxDialogPortal } from '../shell/DialogPortal';
import { createLynxWorktree, deleteLynxWorktree } from './projectActions';
import {
  archiveLynxWorktreeLinkedSessions,
  collectLynxWorktreeLinkedSessions,
  lynxWorktreeHasBranch,
  probeLynxWorktreeDirty,
  type LynxWorktreeLinkedSession,
} from './worktreeDialogs';

export type LynxCreateWorktreeDialogProps = {
  locale: string;
  open: boolean;
  projectDirectory: string;
  runtimeFetch?: LynxRuntimeFetch | null;
  onClose: () => void;
  /** Cap opens draft in the new worktree path when create succeeds. */
  onCreated?: (path: string) => void;
};

/**
 * Cap asks for a worktree name before POST — LynxInput → createLynxWorktree.
 * Elevated panel (ProjectsHome spirit), not a centered confirm dialog.
 */
export function LynxCreateWorktreeDialog({
  locale,
  open,
  projectDirectory,
  runtimeFetch = null,
  onClose,
  onCreated,
}: LynxCreateWorktreeDialogProps) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setName('');
      setBusy(false);
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  return (
    <LynxView
      data-lynx-create-worktree-dialog="true"
      style={{
        padding: '16px',
        backgroundColor: cssVar('surface.elevated'),
        borderTopLeftRadius: '16px',
        borderTopRightRadius: '16px',
      }}
      accessibility-label={lynxT(locale, 'lynx.projects.worktree.createTitle')}
    >
      <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '700', marginBottom: '8px' }}>
        {lynxT(locale, 'lynx.projects.worktree.createTitle')}
      </LynxText>
      {error ? (
        <LynxText style={{ color: cssVar('status.error'), fontSize: '12px', marginBottom: '8px' }}>
          {error}
        </LynxText>
      ) : null}
      <LynxInput
        value={name}
        placeholder={lynxT(locale, 'lynx.projects.worktree.namePlaceholder')}
        bindinput={(event) => {
          const detail = event.detail as { value?: string } | undefined;
          setName(typeof detail?.value === 'string' ? detail.value : '');
        }}
        style={{ color: cssVar('surface.foreground'), fontSize: '15px', marginBottom: '8px' }}
      />
      <LynxView
        bindtap={() => {
          if (busy) return;
          setBusy(true);
          setError(null);
          void (async () => {
            const result = await createLynxWorktree(runtimeFetch, {
              projectDirectory,
              branchName: name,
              worktreeName: name,
            });
            setBusy(false);
            if (result.status === 'ok') {
              onClose();
              onCreated?.(result.path);
              return;
            }
            if (result.status === 'unavailable') {
              setError(lynxT(locale, 'lynx.projects.worktree.createUnavailable'));
              return;
            }
            setError(result.status === 'no-runtime' ? 'no-runtime' : result.error);
          })();
        }}
        style={{ padding: '12px 0', opacity: busy ? 0.6 : 1 }}
      >
        <LynxText style={{ color: cssVar('primary.base'), fontSize: '15px' }}>
          {lynxT(locale, 'lynx.projects.worktree.create')}
        </LynxText>
      </LynxView>
      <LynxView
        bindtap={() => {
          if (busy) return;
          onClose();
        }}
        style={{ padding: '12px 0' }}
      >
        <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
          {lynxT(locale, 'lynx.projects.menu.cancel')}
        </LynxText>
      </LynxView>
    </LynxView>
  );
}

export type LynxDeleteWorktreeDialogProps = {
  locale: string;
  open: boolean;
  projectDirectory: string;
  worktreeDirectory: string;
  worktreeName?: string | null;
  worktreeBranch?: string | null;
  /** Sessions known for this worktree (home model group) and/or broader list. */
  linkedSessions?: LynxWorktreeLinkedSession[];
  runtimeFetch?: LynxRuntimeFetch | null;
  onClose: () => void;
  onDeleted?: () => void;
  /** Optional note sink for parent chrome (ProjectsHome). */
  onErrorNote?: (note: string) => void;
};

/**
 * Cap MobileDeleteWorktreeDialog spirit via LynxCenteredDialog portal.
 * Deepens: deleteLocalBranch toggle + archive linked sessions + dirty warning
 * when Cap git status is reachable. Remote-branch toggle deferred (no Lynx helper).
 */
export function LynxDeleteWorktreeDialog({
  locale,
  open,
  projectDirectory,
  worktreeDirectory,
  worktreeName,
  worktreeBranch,
  linkedSessions = [],
  runtimeFetch = null,
  onClose,
  onDeleted,
  onErrorNote,
}: LynxDeleteWorktreeDialogProps) {
  const [busy, setBusy] = useState(false);
  const [deleteLocalBranch, setDeleteLocalBranch] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [showDirty, setShowDirty] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const hasBranch = lynxWorktreeHasBranch(worktreeBranch);
  const linked = useMemo(
    () => collectLynxWorktreeLinkedSessions(worktreeDirectory, linkedSessions),
    [linkedSessions, worktreeDirectory],
  );

  useEffect(() => {
    if (!open) {
      setBusy(false);
      setDeleteLocalBranch(false);
      setIsDirty(false);
      setShowDirty(false);
      setActionError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const probe = await probeLynxWorktreeDirty(runtimeFetch, worktreeDirectory);
      if (cancelled) return;
      if (probe.status === 'ok') {
        setIsDirty(probe.isDirty);
        setShowDirty(probe.isDirty);
      } else {
        // Honest omit when Cap status unreachable — do not invent dirty/clean.
        setIsDirty(false);
        setShowDirty(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, runtimeFetch, worktreeDirectory]);

  if (!open) return null;

  const displayName = (worktreeName?.trim() || worktreeBranch?.trim() || worktreeDirectory);

  return (
    <LynxDialogPortal>
      <LynxCenteredDialog
        locale={locale}
        open
        title={lynxT(locale, 'lynx.projects.worktree.deleteConfirmTitle')}
        description={lynxT(locale, 'lynx.projects.worktree.deleteConfirmDescription')}
        ariaLabel={lynxT(locale, 'lynx.projects.worktree.deleteConfirmTitle')}
        busy={busy}
        onClose={() => { if (!busy) onClose(); }}
        footer={(
          <>
            <LynxCenteredDialogAction
              label={lynxT(locale, 'lynx.projects.menu.cancel')}
              disabled={busy}
              onTap={() => { if (!busy) onClose(); }}
            />
            <LynxCenteredDialogAction
              label={lynxT(locale, 'lynx.projects.worktree.deleteConfirmAction')}
              destructive
              disabled={busy}
              onTap={() => {
                if (busy) return;
                setBusy(true);
                setActionError(null);
                void (async () => {
                  if (linked.length > 0) {
                    const archived = await archiveLynxWorktreeLinkedSessions(runtimeFetch, linked);
                    if (archived.status === 'no-runtime') {
                      setBusy(false);
                      setActionError('no-runtime');
                      return;
                    }
                    if (archived.status === 'failed' || archived.status === 'partial') {
                      setBusy(false);
                      setActionError(archived.error);
                      return;
                    }
                  }
                  const result = await deleteLynxWorktree(runtimeFetch, {
                    projectDirectory,
                    worktreeDirectory,
                    deleteLocalBranch: hasBranch && deleteLocalBranch,
                  });
                  setBusy(false);
                  if (result.status === 'ok') {
                    onClose();
                    onDeleted?.();
                    return;
                  }
                  const note = result.status === 'unavailable'
                    ? lynxT(locale, 'lynx.projects.worktree.deleteUnavailable')
                    : result.status === 'no-runtime'
                      ? 'no-runtime'
                      : result.error;
                  setActionError(note);
                  onErrorNote?.(note);
                })();
              }}
            />
          </>
        )}
      >
        <LynxText
          data-lynx-delete-worktree-path="true"
          style={{
            color: cssVar('surface.foreground'),
            fontSize: '12px',
            marginBottom: '8px',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          }}
        >
          {displayName}
        </LynxText>
        <LynxText
          style={{
            color: cssVar('surface.mutedForeground'),
            fontSize: '11px',
            marginBottom: '8px',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          }}
        >
          {worktreeDirectory}
        </LynxText>
        {showDirty && isDirty ? (
          <LynxText
            data-lynx-delete-worktree-dirty="true"
            style={{
              color: cssVar('surface.foreground'),
              fontSize: '12px',
              marginBottom: '8px',
              padding: '8px',
              borderRadius: '10px',
              borderWidth: '1px',
              borderColor: cssVar('status.error'),
              backgroundColor: cssVar('surface.muted'),
            }}
          >
            {lynxT(locale, 'lynx.projects.worktree.deleteDirtyWarning')}
          </LynxText>
        ) : null}
        {linked.length > 0 ? (
          <LynxText
            data-lynx-delete-worktree-archive-count={String(linked.length)}
            style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '8px' }}
          >
            {lynxT(locale, 'lynx.projects.worktree.deleteArchiveNote')} ({linked.length})
          </LynxText>
        ) : null}
        {hasBranch ? (
          <LynxView
            data-lynx-delete-worktree-local-branch="true"
            bindtap={() => {
              if (busy) return;
              setDeleteLocalBranch((value) => !value);
            }}
            accessibility-role="switch"
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingTop: '10px',
              paddingBottom: '10px',
              paddingLeft: '12px',
              paddingRight: '12px',
              marginBottom: '8px',
              borderRadius: '12px',
              borderWidth: '1px',
              borderColor: cssVar('surface.mutedForeground'),
              opacity: busy ? 0.5 : 1,
            }}
          >
            <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '13px', flexGrow: 1 }}>
              {lynxT(locale, 'lynx.projects.worktree.deleteLocalBranch')}
            </LynxText>
            <LynxText style={{ color: cssVar('primary.base'), fontSize: '13px', fontWeight: '700' }}>
              {deleteLocalBranch ? 'ON' : 'OFF'}
            </LynxText>
          </LynxView>
        ) : null}
        {actionError ? (
          <LynxText style={{ color: cssVar('status.error'), fontSize: '12px', marginBottom: '4px' }}>
            {actionError}
          </LynxText>
        ) : null}
      </LynxCenteredDialog>
    </LynxDialogPortal>
  );
}
