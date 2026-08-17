import React from 'react'
import type { Session } from '@/lib/opencode/v2-types';import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/icon/Icon'
import { toast } from '@/components/ui'
import { useDeviceInfo } from '@/lib/device'
import { isVSCodeRuntime } from '@/lib/desktop'
import { useI18n } from '@/lib/i18n'
import { formatPathForDisplay, cn } from '@/lib/utils'
import { createSessionOwnershipIndex } from '@/components/session/sidebar/sessionOwnership'
import { formatSessionCompactDateLabel } from '@/components/session/sidebar/utils'
import {
  ensureFullGlobalSessionsLoaded,
  resolveGlobalSessionDirectory,
  useGlobalSessionsStore,
} from '@/stores/useGlobalSessionsStore'
import { useProjectsStore } from '@/stores/useProjectsStore'
import { useUIStore } from '@/stores/useUIStore'
import { unarchiveSession } from '@/sync/session-actions'
import { useSessionUIStore } from '@/sync/session-ui-store'

type ProjectBucket = {
  projectId: string
  label: string
  path: string | null
  sessions: Session[]
}

const OTHER_PROJECT_ID = '__other__'

function getSessionActivityMs(session: Session): number {
  return session.time?.updated ?? session.time?.archived ?? session.time?.created ?? 0
}

export function ArchivedSessionsDialog(): React.ReactNode {
  const { t } = useI18n()
  const { isMobile, isTablet, hasTouchInput } = useDeviceInfo()
  const useMobileOverlay = isMobile || isTablet || hasTouchInput

  const open = useUIStore((state) => state.isArchivedSessionsDialogOpen)
  const setOpen = useUIStore((state) => state.setArchivedSessionsDialogOpen)
  const projects = useProjectsStore((state) => state.projects)
  const archivedSessions = useGlobalSessionsStore((state) => state.archivedSessions)
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession)
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen)

  const [loading, setLoading] = React.useState(false)
  const [selectedProjectId, setSelectedProjectId] = React.useState<string | null>(null)
  const [restoringId, setRestoringId] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) {
      setSelectedProjectId(null)
      setRestoringId(null)
      return
    }
    let cancelled = false
    setLoading(true)
    void ensureFullGlobalSessionsLoaded()
      .catch(() => {
        if (!cancelled) {
          toast.error(t('settings.openchamber.archivedSessions.toast.loadFailed'))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, t])

  const projectBuckets = React.useMemo((): ProjectBucket[] => {
    const ownershipProjects = projects.map((project) => ({
      id: project.id,
      normalizedPath: project.path,
    }))
    const ownership = createSessionOwnershipIndex(
      [],
      ownershipProjects,
      new Map(),
      isVSCodeRuntime(),
      archivedSessions,
    )

    const byProject = new Map<string, Session[]>()
    for (const [projectId, sessions] of ownership.archivedSessionsByProject) {
      byProject.set(projectId, [...sessions].sort((a, b) => getSessionActivityMs(b) - getSessionActivityMs(a)))
    }

    const ownedIds = new Set<string>()
    for (const sessions of byProject.values()) {
      for (const session of sessions) ownedIds.add(session.id)
    }
    const unowned = archivedSessions
      .filter((session) => !ownedIds.has(session.id))
      .sort((a, b) => getSessionActivityMs(b) - getSessionActivityMs(a))
    if (unowned.length > 0) {
      byProject.set(OTHER_PROJECT_ID, unowned)
    }

    const buckets: ProjectBucket[] = []
    for (const project of projects) {
      const sessions = byProject.get(project.id) ?? []
      if (sessions.length === 0) continue
      buckets.push({
        projectId: project.id,
        label: project.label || project.path,
        path: project.path,
        sessions,
      })
    }
    const other = byProject.get(OTHER_PROJECT_ID)
    if (other && other.length > 0) {
      buckets.push({
        projectId: OTHER_PROJECT_ID,
        label: t('settings.openchamber.archivedSessions.otherProjects'),
        path: null,
        sessions: other,
      })
    }
    buckets.sort((a, b) => b.sessions.length - a.sessions.length || a.label.localeCompare(b.label))
    return buckets
  }, [archivedSessions, projects, t])

  const totalArchived = archivedSessions.length
  const selectedBucket = selectedProjectId
    ? projectBuckets.find((bucket) => bucket.projectId === selectedProjectId) ?? null
    : null

  const handleRestore = React.useCallback(async (session: Session) => {
    setRestoringId(session.id)
    try {
      const ok = await unarchiveSession(session.id)
      if (ok) {
        toast.success(t('settings.openchamber.archivedSessions.toast.restored'))
      } else {
        toast.error(t('settings.openchamber.archivedSessions.toast.restoreFailed'))
      }
    } finally {
      setRestoringId(null)
    }
  }, [t])

  const handlePreview = React.useCallback((session: Session) => {
    const directory = resolveGlobalSessionDirectory(session)
    setCurrentSession(session.id, directory)
    setOpen(false)
    setSettingsDialogOpen(false)
  }, [setCurrentSession, setOpen, setSettingsDialogOpen])

  const headerTitle = selectedBucket
    ? selectedBucket.label
    : t('settings.openchamber.archivedSessions.dialog.title')

  const headerDescription = selectedBucket
    ? (selectedBucket.sessions.length === 1
      ? t('settings.openchamber.archivedSessions.dialog.sessionCountSingle', { count: selectedBucket.sessions.length })
      : t('settings.openchamber.archivedSessions.dialog.sessionCountPlural', { count: selectedBucket.sessions.length }))
    : t('settings.openchamber.archivedSessions.dialog.description')

  const body = (
    <div className="space-y-3">
      {selectedBucket ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="!h-7 !px-2 !font-normal text-muted-foreground"
          onClick={() => setSelectedProjectId(null)}
        >
          <Icon name="arrow-left-s" className="mr-1 h-4 w-4" />
          {t('settings.openchamber.archivedSessions.dialog.backToProjects')}
        </Button>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 typography-meta text-muted-foreground py-6">
          <Icon name="loader-4" className="h-4 w-4 animate-spin" />
          {t('settings.openchamber.archivedSessions.dialog.loading')}
        </div>
      ) : !selectedBucket ? (
        projectBuckets.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-4 typography-meta text-muted-foreground">
            {t('settings.openchamber.archivedSessions.dialog.empty')}
          </div>
        ) : (
          <div className="space-y-1.5">
            {projectBuckets.map((bucket) => (
              <button
                key={bucket.projectId}
                type="button"
                onClick={() => setSelectedProjectId(bucket.projectId)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg border border-border/60 px-3 py-2.5 text-left',
                  'hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                )}
              >
                <Icon name="folder" className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="typography-ui-label font-medium text-foreground truncate">{bucket.label}</div>
                  {bucket.path ? (
                    <div className="typography-meta text-muted-foreground truncate">
                      {formatPathForDisplay(bucket.path)}
                    </div>
                  ) : null}
                </div>
                <span className="typography-meta tabular-nums text-muted-foreground shrink-0">
                  {bucket.sessions.length === 1
                    ? t('settings.openchamber.archivedSessions.dialog.sessionCountSingle', { count: bucket.sessions.length })
                    : t('settings.openchamber.archivedSessions.dialog.sessionCountPlural', { count: bucket.sessions.length })}
                </span>
                <Icon name="arrow-right-s" className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            ))}
          </div>
        )
      ) : selectedBucket.sessions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-4 typography-meta text-muted-foreground">
          {t('settings.openchamber.archivedSessions.dialog.emptyProject')}
        </div>
      ) : (
        <div className="space-y-1.5">
          {selectedBucket.sessions.map((session) => {
            const directory = resolveGlobalSessionDirectory(session)
            const activityMs = getSessionActivityMs(session)
            const busy = restoringId === session.id
            return (
              <div
                key={session.id}
                className="flex flex-col gap-2 rounded-lg border border-border/60 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="typography-ui-label font-medium text-foreground truncate">
                    {session.title || t('sessions.sidebar.session.untitled')}
                  </div>
                  <div className="typography-meta text-muted-foreground truncate">
                    {activityMs > 0 ? formatSessionCompactDateLabel(activityMs) : null}
                    {activityMs > 0 && directory ? ' · ' : null}
                    {directory ? formatPathForDisplay(directory) : null}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="!font-normal"
                    disabled={busy}
                    onClick={() => handlePreview(session)}
                  >
                    {t('settings.openchamber.archivedSessions.actions.preview')}
                  </Button>
                  <Button
                    type="button"
                    variant="default"
                    size="xs"
                    className="!font-normal"
                    disabled={busy}
                    onClick={() => void handleRestore(session)}
                  >
                    {busy ? (
                      <Icon name="loader-4" className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Icon name="inbox-unarchive" className="mr-1 h-3.5 w-3.5" />
                    )}
                    {t('settings.openchamber.archivedSessions.actions.restore')}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {!selectedBucket && !loading && totalArchived > 0 ? (
        <p className="typography-meta text-muted-foreground">
          {totalArchived === 1
            ? t('settings.openchamber.archivedSessions.summarySingle', { count: totalArchived })
            : t('settings.openchamber.archivedSessions.summaryPlural', { count: totalArchived })}
        </p>
      ) : null}
    </div>
  )

  if (useMobileOverlay) {
    return (
      <MobileOverlayPanel
        open={open}
        title={headerTitle}
        onClose={() => setOpen(false)}
        contentMaxHeightClassName="max-h-[min(80vh,640px)]"
        renderHeader={(closeButton) => (
          <div className="flex flex-col gap-1 border-b border-border/40 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="typography-ui-label font-semibold text-foreground">{headerTitle}</h2>
              {closeButton}
            </div>
            <p className="typography-micro text-muted-foreground">{headerDescription}</p>
          </div>
        )}
      >
        {body}
      </MobileOverlayPanel>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{headerTitle}</DialogTitle>
          <DialogDescription>{headerDescription}</DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  )
}
