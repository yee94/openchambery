import React from 'react';
import { useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useUIStore } from '@/stores/useUIStore';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import {
    type ChangedFileEntry,
    type GitChangedFile,
    extractGitChangedFiles,
    isGitFile,
} from './changedFiles';
import { ChangedFilesList } from './ChangedFilesList';
import { changedFilesPopoverClassName, changedFilesPopoverStyle } from './changedFilesPopover';
import {
    statusBarTriggerClassName,
    statusBarTriggerIconClassName,
    statusBarTriggerLabelClassName,
    statusBarTriggerMetaClassName,
} from './statusBarPopover';
import { useI18n } from '@/lib/i18n';

export const PendingChangesBar: React.FC = React.memo(() => {
    const { t } = useI18n();
    const [isExpanded, setIsExpanded] = React.useState(false);
    const popoverRef = React.useRef<HTMLDivElement>(null);
    const currentDirectory = useEffectiveDirectory() ?? null;
    const runtime = React.useContext(RuntimeAPIContext);
    const isGitRepo = useIsGitRepo(currentDirectory);
    const gitStatus = useGitStore((s) =>
        currentDirectory ? s.directories.get(currentDirectory)?.status ?? null : null,
    );
    const fetchStatus = useGitStore((s) => s.fetchStatus);
    const mobileActions = useMobileAppActions();

    // Close popover when clicking outside
    React.useEffect(() => {
        if (!isExpanded) return;

        const handleClickOutside = (event: MouseEvent) => {
            if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
                setIsExpanded(false);
            }
        };

        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [isExpanded]);

    const gitChangedFiles = React.useMemo<GitChangedFile[]>(() => {
        if (!currentDirectory || isGitRepo !== true || !gitStatus || gitStatus.isClean) return [];
        return extractGitChangedFiles(gitStatus.files, gitStatus.diffStats, currentDirectory);
    }, [isGitRepo, gitStatus, currentDirectory]);

    const { totalAdded, totalRemoved } = React.useMemo(() => {
        let added = 0;
        let removed = 0;
        for (const file of gitChangedFiles) {
            added += file.insertions;
            removed += file.deletions;
        }
        return { totalAdded: added, totalRemoved: removed };
    }, [gitChangedFiles]);

    if (!currentDirectory || isGitRepo !== true) return null;
    if (gitChangedFiles.length === 0) return null;

    const handleOpenFile = (file: ChangedFileEntry) => {
        if (!currentDirectory) return;
        if (!isGitFile(file)) return;

        setIsExpanded(false);

        const absolutePath = file.path;

        // Dedicated mobile root: open the per-file diff inside the mobile Changes surface.
        if (mobileActions) {
            mobileActions.openChanges({
                diffPath: file.relativePath,
                staged: file.hasStagedChanges && !file.hasWorkingChanges,
            });
            return;
        }

        const editor = runtime?.editor;
        if (editor) {
            void editor.openFile(absolutePath);
            return;
        }

        const store = useUIStore.getState();
        const openStagedDiff = file.hasStagedChanges && !file.hasWorkingChanges;
        if (!store.isMobile) {
            store.openContextDiff(currentDirectory, file.relativePath, openStagedDiff);
            return;
        }
        store.navigateToDiff(file.relativePath, openStagedDiff);
        store.setRightSidebarOpen(false);
    };

    const fileCount = gitChangedFiles.length;
    const labelHead = fileCount === 1
        ? t('chat.pendingChanges.fileCountSingle', { count: fileCount })
        : t('chat.pendingChanges.fileCountPlural', { count: fileCount });

    // Same background refresh as opening the changes/diff view: external commits
    // often land without a local mutation hint, so expand must re-fetch. Keep the
    // current summary on screen; do not flip the status loading flag.
    const handleToggleExpanded = () => {
        const nextExpanded = !isExpanded;
        setIsExpanded(nextExpanded);
        if (!nextExpanded || !currentDirectory || !runtime?.git) return;
        void fetchStatus(currentDirectory, runtime.git, { silent: true });
    };

    return (
        <div className="relative" ref={popoverRef}>
            <button
                type="button"
                className={cn(statusBarTriggerClassName, 'max-w-full text-left')}
                onClick={handleToggleExpanded}
                aria-expanded={isExpanded}
            >
                <Icon name="file-edit" className={statusBarTriggerIconClassName} />
                <span className={cn(statusBarTriggerLabelClassName, 'shrink-0')}>{labelHead}</span>
                <span className={cn('status-row__changed-label', statusBarTriggerLabelClassName)}>
                    {t('chat.pendingChanges.changedInWorkspace')}
                </span>
                <span className={cn(statusBarTriggerMetaClassName, 'items-baseline gap-0.5')}>
                    {totalAdded > 0 ? <span style={{ color: 'var(--status-success)' }}>+{totalAdded}</span> : null}
                    {totalRemoved > 0 ? <span style={{ color: 'var(--status-error)' }}>-{totalRemoved}</span> : null}
                </span>
                {isExpanded ? (
                    <Icon name="arrow-up-s" className={statusBarTriggerIconClassName} />
                ) : (
                    <Icon name="arrow-down-s" className={statusBarTriggerIconClassName} />
                )}
            </button>
            {isExpanded && (
                <div
                    style={changedFilesPopoverStyle}
                    className={cn(
                        changedFilesPopoverClassName,
                        "absolute left-0 bottom-full mb-1 z-50",
                        "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2",
                        "duration-150"
                    )}
                >
                    <ChangedFilesList
                        files={gitChangedFiles}
                        currentDirectory={currentDirectory}
                        onOpenFile={handleOpenFile}
                    />
                </div>
            )}
        </div>
    );
});

PendingChangesBar.displayName = 'PendingChangesBar';
