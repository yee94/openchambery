/**
 * Cap MobileProjectEditSurface spirit for Lynx.
 * Label + icon + color + iconImage discover/remove + worktree list delete +
 * portable ↑/↓ reorder (no @dnd-kit / Cap toast).
 */
import { useEffect, useMemo, useState } from 'react';

import { lynxT } from '../i18n/catalog';
import { LynxInput, LynxScrollView, LynxText, LynxView } from '../lynx-elements';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import type { LynxHomeProject, LynxHomeWorktreeGroup } from '../session-index/homeModel';
import { LynxMobileResizableSheet } from '../shell/MobileResizableSheet';
import { cssVar } from '../theme/tokens';
import {
  discoverLynxProjectIcon,
  fetchLynxWorktreeOrder,
  inferLynxProjectIsGit,
  loadLynxProjectMeta,
  removeLynxProjectIcon,
  setLynxWorktreeOrder,
  updateLynxProjectMeta,
  type LynxProjectIconImage,
  type LynxProjectMeta,
} from './projectActions';
import {
  applyLynxWorktreeOrderPaths,
  lynxEditableWorktreeLabel,
  moveLynxWorktreeOrder,
  normalizeLynxWorktreeOrderPath,
} from './projectEditSurface';
import {
  LYNX_PROJECT_COLORS,
  LYNX_PROJECT_ICONS,
  lynxProjectColorHex,
  lynxProjectIconGlyph,
} from './projectMeta';
import { LynxDeleteWorktreeDialog } from './WorktreeDialogs';

export type LynxProjectEditSurfaceProps = {
  locale: string;
  open: boolean;
  project: LynxHomeProject | null;
  runtimeFetch?: LynxRuntimeFetch | null;
  /** Flat session rows for worktree delete archive (Cap dialog). */
  linkedSessions?: Array<{ id: string; directory?: string | null }>;
  onClose: () => void;
  onSaved?: () => void;
  onWorktreesChanged?: () => void;
};

type EditableWorktree = LynxHomeWorktreeGroup;

export function LynxProjectEditSurface({
  locale,
  open,
  project,
  runtimeFetch = null,
  linkedSessions = [],
  onClose,
  onSaved,
  onWorktreesChanged,
}: LynxProjectEditSurfaceProps) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<string | null>(null);
  const [color, setColor] = useState<string | null>(null);
  const [iconBackground, setIconBackground] = useState<string | null>(null);
  const [iconImage, setIconImage] = useState<LynxProjectIconImage | null>(null);
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [metaStatus, setMetaStatus] = useState<'loading' | 'ready' | 'unavailable' | 'failed' | 'no-runtime'>('loading');
  const [metaError, setMetaError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [orderedWorktrees, setOrderedWorktrees] = useState<EditableWorktree[]>([]);
  const [orderRevision, setOrderRevision] = useState(0);
  const [orderLocalOnly, setOrderLocalOnly] = useState(false);
  const [worktreeToDelete, setWorktreeToDelete] = useState<EditableWorktree | null>(null);

  const projectId = project?.id ?? null;
  const projectPath = project?.path ?? null;
  const isGit = project ? inferLynxProjectIsGit(project) : false;

  const colorHex = lynxProjectColorHex(color);

  useEffect(() => {
    if (!open || !project) return;
    setName(project.label);
    setIcon(null);
    setColor(null);
    setIconBackground(null);
    setIconImage(null);
    setSettingsId(null);
    setMetaStatus('loading');
    setMetaError(null);
    setNote(null);
    setBusy(false);
    setDiscovering(false);
    setWorktreeToDelete(null);
    setOrderedWorktrees(project.worktrees.filter((entry) => entry.kind === 'worktree'));
    setOrderRevision(0);
    setOrderLocalOnly(false);

    let cancelled = false;
    void (async () => {
      const loaded = await loadLynxProjectMeta(runtimeFetch, {
        projectId: project.id,
        path: project.path,
        fallbackLabel: project.label,
      });
      if (cancelled) return;
      if (loaded.status === 'ok') {
        applyMeta(loaded.meta);
        setMetaStatus('ready');
      } else if (loaded.status === 'unavailable') {
        setMetaStatus('unavailable');
        setMetaError(lynxT(locale, 'lynx.projects.edit.unavailable'));
      } else if (loaded.status === 'no-runtime') {
        setMetaStatus('no-runtime');
        setMetaError('no-runtime');
      } else {
        setMetaStatus('failed');
        setMetaError(loaded.error);
      }

      const order = await fetchLynxWorktreeOrder(runtimeFetch, project.path);
      if (cancelled) return;
      if (order.status === 'ok') {
        setOrderRevision(order.revision);
        setOrderLocalOnly(false);
        setOrderedWorktrees((previous) => applyLynxWorktreeOrderPaths(previous, order.orderedPaths));
      } else if (order.status === 'unavailable' || order.status === 'no-runtime') {
        setOrderLocalOnly(true);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Re-seed only when edited project / open changes (Cap spirit).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId, projectPath]);

  useEffect(() => {
    if (!open || !project) return;
    setOrderedWorktrees((previous) => {
      const incoming = project.worktrees.filter((entry) => entry.kind === 'worktree');
      const incomingPaths = incoming.map((entry) => normalizeLynxWorktreeOrderPath(entry.path));
      const previousPaths = previous.map((entry) => normalizeLynxWorktreeOrderPath(entry.path));
      const sameSet = incomingPaths.length === previousPaths.length
        && incomingPaths.every((path) => previousPaths.includes(path));
      if (!sameSet) return incoming;
      return applyLynxWorktreeOrderPaths(incoming, previousPaths);
    });
  }, [open, project, project?.worktrees]);

  const applyMeta = (meta: LynxProjectMeta) => {
    setSettingsId(meta.id);
    setName(meta.label);
    setIcon(meta.icon);
    setColor(meta.color);
    setIconBackground(meta.iconBackground);
    setIconImage(meta.iconImage);
  };

  const canSave = Boolean(name.trim()) && metaStatus === 'ready' && !busy;

  const handleSave = () => {
    if (!project || !canSave) return;
    setBusy(true);
    setMetaError(null);
    setNote(null);
    void (async () => {
      const result = await updateLynxProjectMeta(runtimeFetch, {
        projectId: settingsId || project.id,
        path: project.path,
        label: name,
        icon,
        color,
      });
      setBusy(false);
      if (result.status === 'ok') {
        onSaved?.();
        onClose();
        return;
      }
      if (result.status === 'unavailable') {
        setMetaError(lynxT(locale, 'lynx.projects.edit.unavailable'));
        return;
      }
      setMetaError(result.status === 'no-runtime' ? 'no-runtime' : result.error);
    })();
  };

  const handleDiscover = () => {
    if (!project || discovering || metaStatus !== 'ready') return;
    setDiscovering(true);
    setNote(null);
    setMetaError(null);
    void (async () => {
      const result = await discoverLynxProjectIcon(runtimeFetch, {
        projectId: settingsId || project.id,
        path: project.path,
      });
      setDiscovering(false);
      if (result.status === 'ok') {
        if (result.skipped) {
          setNote(lynxT(locale, 'lynx.projects.edit.icon.customAlreadySet'));
        } else {
          setNote(lynxT(locale, 'lynx.projects.edit.icon.discovered'));
        }
        const reloaded = await loadLynxProjectMeta(runtimeFetch, {
          projectId: settingsId || project.id,
          path: project.path,
          fallbackLabel: name,
        });
        if (reloaded.status === 'ok') applyMeta(reloaded.meta);
        return;
      }
      if (result.status === 'unavailable') {
        setMetaError(result.reason);
        return;
      }
      setMetaError(result.status === 'no-runtime' ? 'no-runtime' : result.error);
    })();
  };

  const handleRemoveIcon = () => {
    if (!project || metaStatus !== 'ready') return;
    setBusy(true);
    setNote(null);
    setMetaError(null);
    void (async () => {
      const result = await removeLynxProjectIcon(runtimeFetch, {
        projectId: settingsId || project.id,
        path: project.path,
      });
      setBusy(false);
      if (result.status === 'ok') {
        setIconImage(null);
        setNote(lynxT(locale, 'lynx.projects.edit.icon.removed'));
        return;
      }
      if (result.status === 'unavailable') {
        setMetaError(result.reason);
        return;
      }
      setMetaError(result.status === 'no-runtime' ? 'no-runtime' : result.error);
    })();
  };

  const handleReorder = (worktreePath: string, direction: 'up' | 'down') => {
    if (!project) return;
    const next = moveLynxWorktreeOrder(orderedWorktrees, worktreePath, direction);
    if (next === orderedWorktrees) return;
    setOrderedWorktrees(next);
    const orderedPaths = next.map((entry) => normalizeLynxWorktreeOrderPath(entry.path));
    void (async () => {
      const result = await setLynxWorktreeOrder(runtimeFetch, {
        projectDirectory: project.path,
        orderedPaths,
        expectedRevision: orderRevision,
      });
      if (result.status === 'ok') {
        setOrderRevision(result.revision);
        setOrderLocalOnly(false);
        setNote(null);
        return;
      }
      // Cap keeps Zustand local even when sync lags — Lynx keeps session-local order
      // and labels the server gap honestly (never fake server success).
      setOrderLocalOnly(true);
      if (result.status === 'unavailable' || result.status === 'no-runtime') {
        setNote(lynxT(locale, 'lynx.projects.edit.reorder.localOnly'));
        return;
      }
      setNote(lynxT(locale, 'lynx.projects.edit.reorder.localOnly'));
      setMetaError(result.error);
    })();
  };

  const previewGlyph = useMemo(() => {
    if (iconImage) return '🖼';
    return lynxProjectIconGlyph(icon);
  }, [icon, iconImage]);

  if (!project) return null;

  return (
    <>
      <LynxMobileResizableSheet
        locale={locale}
        open={open}
        title={lynxT(locale, 'lynx.projects.edit.title')}
        ariaLabel={lynxT(locale, 'lynx.projects.edit.title')}
        onClose={onClose}
        initiallyExpanded
        trailing={(
          <LynxView
            bindtap={() => {
              if (!canSave) return;
              handleSave();
            }}
            accessibility-role="button"
            accessibility-label={lynxT(locale, 'lynx.projects.edit.save')}
            style={{ opacity: canSave ? 1 : 0.45 }}
          >
            <LynxText style={{ color: cssVar('primary.base'), fontWeight: '700' }}>
              {lynxT(locale, 'lynx.projects.edit.save')}
            </LynxText>
          </LynxView>
        )}
      >
        <LynxScrollView style={{ flexGrow: 1, minHeight: '0' }}>
          <LynxView style={{ paddingBottom: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <LynxView style={{ alignItems: 'center', paddingTop: '8px' }}>
              <LynxView
                style={{
                  width: '64px',
                  height: '64px',
                  borderRadius: '16px',
                  backgroundColor: iconBackground || cssVar('surface.muted'),
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <LynxText style={{
                  fontSize: '28px',
                  color: colorHex || cssVar('surface.mutedForeground'),
                }}
                >
                  {previewGlyph}
                </LynxText>
              </LynxView>
            </LynxView>

            {metaError ? (
              <LynxText style={{ color: cssVar('status.error'), fontSize: '12px' }}>
                {metaError}
              </LynxText>
            ) : null}
            {note ? (
              <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
                {note}
              </LynxText>
            ) : null}
            {metaStatus === 'loading' ? (
              <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
                {lynxT(locale, 'lynx.projects.edit.loading')}
              </LynxText>
            ) : null}

            <LynxView style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '600' }}>
                {lynxT(locale, 'lynx.projects.edit.label')}
              </LynxText>
              <LynxInput
                value={name}
                placeholder={lynxT(locale, 'lynx.projects.edit.label')}
                bindinput={(event) => {
                  const detail = event.detail as { value?: string } | undefined;
                  setName(typeof detail?.value === 'string' ? detail.value : '');
                }}
                style={{
                  color: cssVar('surface.foreground'),
                  fontSize: '15px',
                  padding: '10px',
                  borderRadius: '10px',
                  borderWidth: '1px',
                  borderColor: cssVar('surface.mutedForeground'),
                }}
              />
              <LynxText
                style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}
                accessibility-label={project.path}
              >
                {project.path}
              </LynxText>
            </LynxView>

            <LynxView style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '600' }}>
                {lynxT(locale, 'lynx.projects.edit.color')}
              </LynxText>
              <LynxView style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: '8px' }}>
                <LynxView
                  bindtap={() => setColor(null)}
                  accessibility-role="button"
                  accessibility-label={lynxT(locale, 'lynx.projects.edit.none')}
                  style={{
                    width: '36px',
                    height: '36px',
                    borderRadius: '12px',
                    borderWidth: '2px',
                    borderColor: color === null ? cssVar('surface.foreground') : cssVar('surface.mutedForeground'),
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>—</LynxText>
                </LynxView>
                {LYNX_PROJECT_COLORS.map((entry) => (
                  <LynxView
                    key={entry.key}
                    bindtap={() => setColor(entry.key)}
                    accessibility-role="button"
                    accessibility-label={entry.label}
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '12px',
                      backgroundColor: entry.hex,
                      borderWidth: '2px',
                      borderColor: color === entry.key ? cssVar('surface.foreground') : 'transparent',
                    }}
                  />
                ))}
              </LynxView>
            </LynxView>

            <LynxView style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '600' }}>
                {lynxT(locale, 'lynx.projects.edit.icon')}
              </LynxText>
              <LynxView style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: '8px' }}>
                <LynxView
                  bindtap={() => setIcon(null)}
                  accessibility-role="button"
                  accessibility-label={lynxT(locale, 'lynx.projects.edit.none')}
                  style={{
                    width: '36px',
                    height: '36px',
                    borderRadius: '12px',
                    borderWidth: '2px',
                    borderColor: icon === null ? cssVar('surface.foreground') : cssVar('surface.mutedForeground'),
                    backgroundColor: cssVar('surface.elevated'),
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>—</LynxText>
                </LynxView>
                {LYNX_PROJECT_ICONS.map((entry) => (
                  <LynxView
                    key={entry.key}
                    bindtap={() => setIcon(entry.key)}
                    accessibility-role="button"
                    accessibility-label={entry.label}
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '12px',
                      borderWidth: '2px',
                      borderColor: icon === entry.key ? cssVar('surface.foreground') : cssVar('surface.mutedForeground'),
                      backgroundColor: cssVar('surface.elevated'),
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <LynxText style={{
                      fontSize: '14px',
                      color: colorHex || cssVar('surface.foreground'),
                    }}
                    >
                      {entry.glyph}
                    </LynxText>
                  </LynxView>
                ))}
              </LynxView>
              <LynxView style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: '12px', paddingTop: '4px' }}>
                <LynxView
                  bindtap={() => {
                    if (!discovering) handleDiscover();
                  }}
                  accessibility-role="button"
                  style={{ opacity: discovering || metaStatus !== 'ready' ? 0.5 : 1 }}
                >
                  <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600', fontSize: '13px' }}>
                    {discovering
                      ? lynxT(locale, 'lynx.projects.edit.icon.discovering')
                      : lynxT(locale, 'lynx.projects.edit.icon.discover')}
                  </LynxText>
                </LynxView>
                {iconImage ? (
                  <LynxView
                    bindtap={handleRemoveIcon}
                    accessibility-role="button"
                    style={{ opacity: busy ? 0.5 : 1 }}
                  >
                    <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '600', fontSize: '13px' }}>
                      {lynxT(locale, 'lynx.projects.edit.icon.remove')}
                    </LynxText>
                  </LynxView>
                ) : null}
              </LynxView>
            </LynxView>

            {isGit ? (
              <LynxView style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '600' }}>
                  {lynxT(locale, 'lynx.projects.edit.worktrees')}
                </LynxText>
                {orderedWorktrees.length === 0 ? (
                  <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
                    {lynxT(locale, 'lynx.projects.edit.worktreesEmpty')}
                  </LynxText>
                ) : (
                  <>
                    <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
                      {orderLocalOnly
                        ? lynxT(locale, 'lynx.projects.edit.reorder.localOnly')
                        : lynxT(locale, 'lynx.projects.edit.reorderHint')}
                    </LynxText>
                    {orderedWorktrees.map((worktree, index) => {
                      const label = lynxEditableWorktreeLabel({
                        branch: worktree.branch,
                        name: worktree.name,
                        path: worktree.path,
                      });
                      return (
                        <LynxView
                          key={worktree.path}
                          style={{
                            display: 'flex',
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: '6px',
                            padding: '8px',
                            borderRadius: '14px',
                            borderWidth: '1px',
                            borderColor: cssVar('surface.mutedForeground'),
                            backgroundColor: cssVar('surface.elevated'),
                          }}
                        >
                          <LynxView
                            bindtap={() => handleReorder(worktree.path, 'up')}
                            accessibility-role="button"
                            accessibility-label={lynxT(locale, 'lynx.projects.edit.reorderUp')}
                            style={{ opacity: index === 0 ? 0.35 : 1, padding: '6px' }}
                          >
                            <LynxText style={{ color: cssVar('surface.foreground') }}>↑</LynxText>
                          </LynxView>
                          <LynxView
                            bindtap={() => handleReorder(worktree.path, 'down')}
                            accessibility-role="button"
                            accessibility-label={lynxT(locale, 'lynx.projects.edit.reorderDown')}
                            style={{
                              opacity: index === orderedWorktrees.length - 1 ? 0.35 : 1,
                              padding: '6px',
                            }}
                          >
                            <LynxText style={{ color: cssVar('surface.foreground') }}>↓</LynxText>
                          </LynxView>
                          <LynxText
                            style={{
                              flexGrow: 1,
                              minWidth: '0',
                              color: cssVar('surface.foreground'),
                              fontSize: '14px',
                            }}
                          >
                            {label}
                          </LynxText>
                          <LynxView
                            bindtap={() => setWorktreeToDelete(worktree)}
                            accessibility-role="button"
                            accessibility-label={lynxT(locale, 'lynx.projects.edit.deleteWorktree', { label })}
                            style={{ padding: '6px' }}
                          >
                            <LynxText style={{ color: cssVar('status.error') }}>⌫</LynxText>
                          </LynxView>
                        </LynxView>
                      );
                    })}
                  </>
                )}
              </LynxView>
            ) : null}
          </LynxView>
        </LynxScrollView>
      </LynxMobileResizableSheet>

      {worktreeToDelete ? (
        <LynxDeleteWorktreeDialog
          locale={locale}
          open
          projectDirectory={project.path}
          worktreeDirectory={worktreeToDelete.path}
          worktreeName={worktreeToDelete.name}
          worktreeBranch={worktreeToDelete.branch}
          linkedSessions={linkedSessions}
          runtimeFetch={runtimeFetch}
          onClose={() => setWorktreeToDelete(null)}
          onDeleted={() => {
            const removedPath = worktreeToDelete.path;
            setWorktreeToDelete(null);
            setOrderedWorktrees((previous) => previous.filter((entry) => entry.path !== removedPath));
            onWorktreesChanged?.();
          }}
          onErrorNote={(message) => setMetaError(message)}
        />
      ) : null}
    </>
  );
}
