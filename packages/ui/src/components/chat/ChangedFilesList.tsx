import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { type ChangedFileEntry, getDisplayPath, getFileStats } from './changedFiles';
import {
    statusBarPopoverHeaderClassName,
    statusBarPopoverHeaderMetaClassName,
    statusBarPopoverHeaderTitleClassName,
    statusBarPopoverListClassName,
    statusBarPopoverRowClassName,
} from './statusBarPopover';
import { TruncatedPath } from '@/components/ui/truncated-path';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface ChangedFilesListProps {
    files: ChangedFileEntry[];
    currentDirectory: string;
    onOpenFile: (file: ChangedFileEntry) => void;
}

// Above this count only the visible window is mounted; the list stays complete.
const VIRTUALIZE_THRESHOLD = 200;
const ROW_ESTIMATE_PX = 32;
const LIST_MAX_HEIGHT_PX = 352;

interface ChangedFileRowProps {
    file: ChangedFileEntry;
    currentDirectory: string;
    onOpenFile: (file: ChangedFileEntry) => void;
}

const ChangedFileRow: React.FC<ChangedFileRowProps> = ({ file, currentDirectory, onOpenFile }) => {
    const { t } = useI18n();
    const { fileName, dirPart } = getDisplayPath(file, currentDirectory);
    const stats = getFileStats(file);

    return (
        <button
            type="button"
            className={cn(
                'relative flex w-full cursor-pointer items-center gap-2.5 outline-hidden select-none text-left hover:bg-interactive-hover',
                statusBarPopoverRowClassName,
            )}
            title={t('chat.changedFiles.actions.openFileTitle', { path: file.path })}
            onClick={() => onOpenFile(file)}
        >
            <FileTypeIcon filePath={file.path} className="h-3 w-3 shrink-0 md:h-3.5 md:w-3.5" />
            <TruncatedPath
                path={dirPart ? `${dirPart}/${fileName}` : fileName}
                title={file.path}
                className="min-w-0 flex-1"
            />
            {(stats.additions > 0 || stats.deletions > 0) ? (
                <span className="flex-shrink-0 inline-flex items-baseline gap-1 text-xs tabular-nums leading-4 md:text-[0.8125rem] md:leading-5">
                    {stats.additions > 0 ? <span style={{ color: 'var(--status-success)' }}>+{stats.additions}</span> : null}
                    {stats.deletions > 0 ? <span style={{ color: 'var(--status-error)' }}>-{stats.deletions}</span> : null}
                </span>
            ) : null}
        </button>
    );
};

// Rows are single-line and uniform, so one measured height sizes every row.
// Per-row measurement would rebuild offsets for the whole list on every scroll
// step that mounts an unmeasured row (O(n) per frame at tens of thousands).
const VirtualizedChangedFiles: React.FC<ChangedFilesListProps> = ({ files, currentDirectory, onOpenFile }) => {
    const scrollRef = React.useRef<HTMLDivElement | null>(null);
    const sampleRowRef = React.useRef<HTMLDivElement | null>(null);
    const [rowSize, setRowSize] = React.useState(ROW_ESTIMATE_PX);
    // Stable identity: the virtualizer rebuilds every row offset whenever
    // getItemKey changes, so a per-render closure costs O(n) per scroll frame.
    const getItemKey = React.useMemo(() => (index: number) => files[index]?.path ?? index, [files]);
    const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
        count: files.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => rowSize,
        initialRect: { width: 0, height: LIST_MAX_HEIGHT_PX },
        overscan: 8,
        getItemKey,
    });

    React.useLayoutEffect(() => {
        const measured = sampleRowRef.current?.offsetHeight ?? 0;
        if (measured > 0 && measured !== rowSize) setRowSize(measured);
    }, [rowSize]);

    React.useLayoutEffect(() => {
        virtualizer.measure();
    }, [rowSize, virtualizer]);

    const virtualItems = virtualizer.getVirtualItems();
    const sampleIndex = virtualItems[0]?.index;

    return (
        <div ref={scrollRef} className={statusBarPopoverListClassName}>
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualItems.map((item) => {
                    const file = files[item.index];
                    if (!file) return null;
                    return (
                        <div
                            key={item.key}
                            data-index={item.index}
                            ref={item.index === sampleIndex ? sampleRowRef : undefined}
                            // Divider as inset shadow keeps every row the same height.
                            className={cn(item.index > 0 && 'shadow-[inset_0_1px_0_0_var(--surface-subtle)]')}
                            style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                transform: `translateY(${item.start}px)`,
                            }}
                        >
                            <ChangedFileRow file={file} currentDirectory={currentDirectory} onOpenFile={onOpenFile} />
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export const ChangedFilesList: React.FC<ChangedFilesListProps> = ({ files, currentDirectory, onOpenFile }) => {
    const { t } = useI18n();
    return (
        <>
            <div className={statusBarPopoverHeaderClassName}>
                <span className={statusBarPopoverHeaderTitleClassName}>{t('chat.changedFiles.title')}</span>
                <span className={statusBarPopoverHeaderMetaClassName}>{files.length}</span>
            </div>

            {files.length > VIRTUALIZE_THRESHOLD ? (
                <VirtualizedChangedFiles files={files} currentDirectory={currentDirectory} onOpenFile={onOpenFile} />
            ) : (
                <div className={statusBarPopoverListClassName}>
                    {files.map((file, index) => (
                        <ChangedFileRow
                            key={`${file.path}:${index}`}
                            file={file}
                            currentDirectory={currentDirectory}
                            onOpenFile={onOpenFile}
                        />
                    ))}
                </div>
            )}
        </>
    );
};
