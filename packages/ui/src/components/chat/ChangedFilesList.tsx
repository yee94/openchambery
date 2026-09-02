import React from 'react';
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

export const ChangedFilesList: React.FC<ChangedFilesListProps> = ({ files, currentDirectory, onOpenFile }) => {
    const { t } = useI18n();
    return (
        <>
            <div className={statusBarPopoverHeaderClassName}>
                <span className={statusBarPopoverHeaderTitleClassName}>{t('chat.changedFiles.title')}</span>
                <span className={statusBarPopoverHeaderMetaClassName}>{files.length}</span>
            </div>

            <div className={statusBarPopoverListClassName}>
                {files.map((file, index) => {
                    const { fileName, dirPart } = getDisplayPath(file, currentDirectory);
                    const stats = getFileStats(file);

                    return (
                        <button
                            key={`${file.path}:${index}`}
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
                })}
            </div>
        </>
    );
};
