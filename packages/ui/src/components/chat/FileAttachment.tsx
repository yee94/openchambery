import React, { useRef, memo } from 'react';
import { useEvent, useIntersectionObserver } from '@reactuses/core';
import { useInputStore } from '@/sync/input-store';
import type { AttachedFile } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { openExternalUrl } from '@/lib/url';
import { isDrawioFile } from '@/lib/toolHelpers';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import { useDeviceInfo } from '@/lib/device';
import {
  isCodeSelectionFilePart,
  isDirectoryAttachmentMime,
  isDirectoryAttachmentPath,
} from './attachmentCitations';
import { attachmentCitationDisplay } from '@/composer/inline-visual';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { createMobileLongPressController } from '@/components/ui/mobileLongPress';
import { openImageSaveActions } from './imageSaveActionsBus';
import { useResolvedImageSource, useRuntimeTransportIdentity, imageRequiresManualLoadOverRelay, isRelayTransport } from './imageSource';
import { Button } from '@/components/ui/button';
import { useSessionParts } from '@/sync/sync-context';
import { getLastFetchedSessionMessageParts } from '@/sync/transcript-parent-recovery';
import {
  getTranscriptMessageMaterializationState,
  materializeTranscriptMessage,
} from '@/sync/transcript-repository-runtime';

import type { ToolPopupContent } from './message/types';

const FileAttachmentButton = memo(() => {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addAttachedFile = useInputStore((state) => state.addAttachedFile);
  const isMobile = useUIStore((state) => state.isMobile);
  const runtimeApis = useRuntimeAPIs();
  const isVSCodeRuntime = runtimeApis.runtime.isVSCode;
  const buttonSizeClass = isMobile ? 'h-9 w-9' : 'h-7 w-7';
  const iconSizeClass = isMobile ? 'h-5 w-5' : 'h-[18px] w-[18px]';

  const attachFiles = async (files: FileList | File[]) => {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        await addAttachedFile(file);
      } catch (error) {
        console.error('File attach failed', error);
        toast.error(error instanceof Error ? error.message : t('chat.fileAttachment.toast.attachFailed'));
      }
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    await attachFiles(files);

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleVSCodePick = async () => {
    try {
      const data = (await runtimeApis.vscode?.pickFiles?.()) as {
        files?: Array<{ name: string; mimeType?: string; dataUrl?: string }>;
        skipped?: Array<{ name?: string; reason?: string }>;
      } | undefined;
      const picked = Array.isArray(data?.files) ? data.files : [];
      const skipped = Array.isArray(data?.skipped) ? data.skipped : [];

      if (skipped.length > 0) {
        const summary = skipped.map((s: { name?: string; reason?: string }) => `${s?.name || t('chat.fileAttachment.fileFallback')}: ${s?.reason || t('chat.fileAttachment.skippedFallback')}`).join('\n');
        toast.error(t('chat.fileAttachment.toast.someFilesSkipped', { summary }));
      }

      const asFiles = picked
        .map((file: { name: string; mimeType?: string; dataUrl?: string }) => {
          if (!file?.dataUrl) return null;
          try {
            const [meta, base64] = file.dataUrl.split(',');
            const mime = file.mimeType || (meta?.match(/data:(.*);base64/)?.[1] || 'application/octet-stream');
            if (!base64) return null;
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            const blob = new Blob([bytes], { type: mime });
            return new File([blob], file.name || t('chat.fileAttachment.fileFallback'), { type: mime });
          } catch (err) {
            console.error('Failed to decode VS Code picked file', err);
            return null;
          }
        })
        .filter(Boolean) as File[];

      if (asFiles.length > 0) {
        await attachFiles(asFiles);
      }
    } catch (error) {
      console.error('VS Code file pick failed', error);
      toast.error(error instanceof Error ? error.message : t('chat.fileAttachment.toast.vscodePickFailed'));
    }
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileSelect}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={isVSCodeRuntime ? handleVSCodePick : () => fileInputRef.current?.click()}
            className={cn(
              'flex items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              'hover:bg-muted text-muted-foreground',
              buttonSizeClass
            )}
            aria-label={t('chat.fileAttachment.actions.attachAria')}
          >
            <Icon name="attachment-2" className={iconSizeClass} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>{t('chat.fileAttachment.actions.attach')}</p>
        </TooltipContent>
      </Tooltip>
    </>
  );
});

FileAttachmentButton.displayName = 'FileAttachmentButton';

interface ImagePreviewProps {
  file: AttachedFile;
  onRemove: () => void;
  onShowPopup?: (content: ToolPopupContent) => void;
  gallery?: NonNullable<ToolPopupContent['image']>['gallery'];
  index?: number;
}

const ImagePreview = memo(({ file, onRemove, onShowPopup, gallery, index = 0 }: ImagePreviewProps) => {
  const { t } = useI18n();
  const { isMobile, isTablet } = useDeviceInfo();
  const alwaysShowActions = isMobile || isTablet;
  const isLocalImagePreview =
    file.source !== 'server' &&
    file.mimeType.startsWith('image/') &&
    typeof file.dataUrl === 'string' &&
    file.dataUrl.startsWith('data:image/');

  const imageUrl = isLocalImagePreview ? file.dataUrl : (file.serverPath || '');
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const displayImageUrl = useResolvedImageSource(imageUrl, effectiveDirectory);
  const longPressKey = `attachment-image:${file.id}`;
  const longPressRef = React.useRef(createMobileLongPressController());

  const extractFilename = (path: string): string => {
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/');
    return parts[parts.length - 1] || path;
  };

  const getFileExtension = (filename: string): string => {
    const parts = filename.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
  };

  const displayName = extractFilename(file.filename);
  const extension = getFileExtension(file.filename);

  const openSaveActions = useEvent(() => {
    if (!imageUrl && !displayImageUrl) return;
    openImageSaveActions({
      sourceUrl: imageUrl || displayImageUrl,
      displayUrl: displayImageUrl || undefined,
      filename: displayName,
      mimeType: file.mimeType,
      effectiveDirectory,
    });
  });

  const handleOpenPreview = useEvent(() => {
    if (longPressRef.current.consumeClick(longPressKey)) return;
    if (!onShowPopup || !imageUrl) return;

    onShowPopup({
      open: true,
      title: displayName || 'Image',
      content: '',
      metadata: {
        tool: 'image-preview',
        filename: displayName,
        mime: file.mimeType,
        size: file.size,
      },
      image: {
        url: imageUrl,
        mimeType: file.mimeType,
        filename: displayName,
        size: file.size,
        gallery,
        index,
      },
    });
  });

  if (!imageUrl) {
    // Fallback to text-only for server images without preview
    return (
      <button
        type="button"
        className="flex items-center gap-1.5 text-sm hover:opacity-80 transition-opacity text-left h-5"
      >
        <FileTypeIcon filePath={file.filename} extension={extension} className="h-4 w-4" />
        <span className="text-foreground truncate max-w-[200px]">
          {displayName}
        </span>
        <span
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="flex items-center justify-center h-5 w-5 flex-shrink-0 hover:bg-[var(--interactive-hover)] rounded-full transition-colors cursor-pointer"
          aria-label={t('chat.fileAttachment.actions.removeNamed', { name: displayName })}
        >
          <Icon name="close" className="h-4 w-4 text-muted-foreground" />
        </span>
      </button>
    );
  }

  return (
    <div
      role={onShowPopup ? 'button' : undefined}
      tabIndex={onShowPopup ? 0 : undefined}
      onClick={handleOpenPreview}
      onKeyDown={(event) => {
        if (!onShowPopup) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          handleOpenPreview();
        }
      }}
      onPointerDown={(event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        longPressRef.current.start({
          pointerId: event.pointerId,
          key: longPressKey,
          clientX: event.clientX,
          clientY: event.clientY,
          onTrigger: openSaveActions,
        });
      }}
      onPointerMove={(event) => {
        longPressRef.current.move(event.pointerId, event.clientX, event.clientY);
      }}
      onPointerUp={(event) => {
        longPressRef.current.end(event.pointerId);
      }}
      onPointerCancel={(event) => {
        longPressRef.current.cancel(event.pointerId);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        longPressRef.current.openFromContextMenu(longPressKey, openSaveActions);
      }}
      className="relative h-10 w-10 rounded-lg border border-border/40 bg-muted/10 overflow-hidden flex-shrink-0 group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      aria-label={displayName}
    >
      <img
        src={displayImageUrl || undefined}
        alt={displayName}
        className="h-full w-full object-cover"
        loading="lazy"
        draggable={false}
      />
      <button
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        className={cn(
          "absolute top-0.5 right-0.5 h-4 w-4 rounded-full bg-transparent text-foreground hover:text-destructive flex items-center justify-center transition-opacity focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          alwaysShowActions ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        )}
        title={t('chat.fileAttachment.actions.removeImage')}
        aria-label={t('chat.fileAttachment.actions.removeNamed', { name: displayName })}
      >
        <Icon name="close" className="h-2.5 w-2.5" />
      </button>
    </div>
  );
});

ImagePreview.displayName = 'ImagePreview';

const useFileDetails = (file: AttachedFile) => {
  const getFileExtension = (filename: string): string => {
    const parts = filename.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
  };

  const formatFileSize = (bytes: number) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const extractFilename = (path: string): string => {
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/');
    const filename = parts[parts.length - 1];
    return filename || path;
  };

  return {
    displayName: extractFilename(file.filename),
    fileSize: formatFileSize(file.size),
    extension: getFileExtension(file.filename),
  };
};

interface FileChipProps {
  file: AttachedFile;
  onRemove: () => void;
}

const FileChip = memo(({ file, onRemove }: FileChipProps) => {
  const { t } = useI18n();
  const { displayName, fileSize, extension } = useFileDetails(file);
  const isDirectory = isDirectoryAttachmentMime(file.mimeType)
    || isDirectoryAttachmentPath(file.filename)
    || isDirectoryAttachmentPath(file.serverPath);

  return (
    <button
      type="button"
      onClick={(e) => {
        // Prevent click from bubbling if clicking the remove button
        if ((e.target as HTMLElement).closest('[data-remove-button]')) {
          return;
        }
      }}
      className="flex items-center gap-1.5 text-sm hover:opacity-80 transition-opacity text-left h-5"
    >
      <FileTypeIcon filePath={file.filename} extension={extension} isDirectory={isDirectory} className="h-4 w-4" />
      <span className="text-foreground truncate max-w-[200px]">
        {displayName}
        {fileSize && <span className="text-muted-foreground ml-1">({fileSize})</span>}
      </span>
      <span
        data-remove-button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="flex items-center justify-center h-5 w-5 flex-shrink-0 hover:bg-[var(--interactive-hover)] rounded-full transition-colors cursor-pointer"
        aria-label={t('chat.fileAttachment.actions.removeNamed', { name: displayName })}
      >
        <Icon name="close" className="h-4 w-4 text-muted-foreground" />
      </span>
    </button>
  );
});

FileChip.displayName = 'FileChip';

const VSCodeFileChip = memo(({ file, onRemove }: FileChipProps) => {
  const { t } = useI18n();
  const { displayName, extension } = useFileDetails(file);

  // Detect selection-style attachments: ends with ":N" or ":N-M"
  const isSelectionAttachment = /:\d+(?:-\d+)?$/.test(displayName);

  return (
    <button
      type="button"
      onClick={(e) => {
        // Prevent click from bubbling if clicking the remove button
        if ((e.target as HTMLElement).closest('[data-remove-button]')) {
          return;
        }
      }}
      className="inline-flex items-center gap-1 text-xs pr-1 rounded-sm border border-solid bg-transparent text-foreground not-italic hover:opacity-90 transition-colors text-left"
      style={{ borderColor: 'var(--syntax-punctuation)' }}
      title={file.vscodePath}
    >
      <span
        data-remove-button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="flex items-center justify-center h-5 w-5 flex-shrink-0 hover:bg-[var(--interactive-hover)] rounded-full transition-colors cursor-pointer"
        aria-label={t('chat.fileAttachment.activeEditor.remove')}
        title={t('chat.fileAttachment.activeEditor.remove')}
      >
        <Icon name="close" className="h-4 w-4 text-muted-foreground" />
      </span>
        <FileTypeIcon filePath={file.filename} extension={extension} className="h-4 w-4" />
        <span className={cn('text-foreground', isSelectionAttachment ? 'whitespace-nowrap' : 'truncate max-w-[200px]')}>
          {displayName}
        </span>
    </button>
  );
});

VSCodeFileChip.displayName = 'VSCodeFileChip';

interface AttachedFilesListProps {
  attachments: readonly AttachedFile[];
  onShowPopup?: (content: ToolPopupContent) => void;
  onRemoveAttachedFile: (file: AttachedFile) => void;
}

export const AttachedVSCodeFileChips = memo(({ attachments, onShowPopup, onRemoveAttachedFile }: AttachedFilesListProps) => {
  const attachedFiles = attachments;
  const vscodeFiles = attachedFiles.filter((file) => file.source === 'vscode' && file.vscodeSource === 'file');

  if (vscodeFiles.length === 0) return null;

  const images = vscodeFiles.filter((f) => f.mimeType.startsWith('image/'));
  const otherFiles = vscodeFiles.filter((f) => !f.mimeType.startsWith('image/'));
  const imageGallery = images.map((file) => ({
    url: file.dataUrl || file.serverPath || '',
    mimeType: file.mimeType,
    filename: file.filename,
    size: file.size,
  })).filter((image) => image.url);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {images.map((file, index) => (
        <ImagePreview key={file.id} file={file} onRemove={() => onRemoveAttachedFile(file)} onShowPopup={onShowPopup} gallery={imageGallery} index={index} />
      ))}
      {otherFiles.map((file) => (
        <VSCodeFileChip key={file.id} file={file} onRemove={() => onRemoveAttachedFile(file)} />
      ))}
    </div>
  );
});

AttachedVSCodeFileChips.displayName = 'AttachedVSCodeFileChips';

export const AttachedFilesList = memo(({ attachments, onShowPopup, onRemoveAttachedFile }: AttachedFilesListProps) => {
  const attachedFiles = attachments;
  const localFiles = attachedFiles.filter((file) => file.source !== 'server' && file.source !== 'vscode');

  if (localFiles.length === 0) return null;

  const images = localFiles.filter((f) => f.mimeType.startsWith('image/'));
  const otherFiles = localFiles.filter((f) => !f.mimeType.startsWith('image/'));
  const imageGallery = images.map((file) => ({
    url: file.dataUrl || file.serverPath || '',
    mimeType: file.mimeType,
    filename: file.filename,
    size: file.size,
  })).filter((image) => image.url);

  return (
    <div className="pb-4 w-full px-1 space-y-3">
      {/* Images row - inline with previews */}
      {images.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {images.map((file, index) => (
            <ImagePreview
              key={file.id}
              file={file}
              onRemove={() => onRemoveAttachedFile(file)}
              onShowPopup={onShowPopup}
              gallery={imageGallery}
              index={index}
            />
          ))}
        </div>
      )}
      
      {/* Other files row - inline text-only */}
      {otherFiles.length > 0 && (
        <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
          {otherFiles.map((file) => (
            <FileChip
              key={file.id}
              file={file}
              onRemove={() => onRemoveAttachedFile(file)}
            />
          ))}
        </div>
      )}
    </div>
  );
});

AttachedFilesList.displayName = 'AttachedFilesList';

type ActiveEditorFileSuggestionProps = {
  /** Composer-owned attachment views (DraftKey for primary). Avoid reading legacy attachedFiles. */
  attachedFiles: readonly AttachedFile[]
  onAddVSCodeFile: (path: string, name: string, fileSize: number | null) => void
  onAddVSCodeSelection: (path: string, file: File) => void | Promise<void>
}

/** Pure helpers for ActiveEditorFileSuggestion attach-state (testable without React). */
// eslint-disable-next-line react-refresh/only-export-components -- Pure helper is tested directly.
export const isActiveEditorFileAttached = (
  attachedFiles: readonly AttachedFile[],
  filePath: string,
): boolean => attachedFiles.some(
  (f) => f.source === 'vscode' && f.vscodeSource === 'file' && (f.vscodePath || '') === filePath,
)

// eslint-disable-next-line react-refresh/only-export-components -- Pure helper is tested directly.
export const isActiveEditorSelectionAttached = (
  attachedFiles: readonly AttachedFile[],
  filePath: string,
  selectionLabel: string,
): boolean => !!selectionLabel && attachedFiles.some(
  (f) => f.source === 'vscode' && f.vscodeSource === 'selection' && f.filename === selectionLabel && f.vscodePath === filePath,
)

// eslint-disable-next-line react-refresh/only-export-components -- Pure helper is tested directly.
export const activeEditorSelectionLabel = (
  relativePath: string,
  selection: { startLine: number; endLine: number } | null | undefined,
): string => {
  if (!selection) return ''
  const selectionRange = selection.startLine === selection.endLine
    ? `${selection.startLine}`
    : `${selection.startLine}-${selection.endLine}`
  return `${relativePath}:${selectionRange}`
}

export const ActiveEditorFileSuggestion = memo(({
  attachedFiles,
  onAddVSCodeFile,
  onAddVSCodeSelection,
}: ActiveEditorFileSuggestionProps) => {
  const { t } = useI18n();
  const activeEditorFile = useInputStore((s) => s.activeEditorFile);
  const setPendingInputText = useInputStore((s) => s.setPendingInputText)
  const isVSCodeRuntime = useRuntimeAPIs().runtime.isVSCode;

  if (!isVSCodeRuntime || !activeEditorFile) return null;

  const { filePath, fileName, relativePath, selection, fileSize } = activeEditorFile;

  // Normalize to forward slashes for comparison
  const isFileAttached = isActiveEditorFileAttached(attachedFiles, filePath)

  // Compute selection label using a compact range (single line shown as "N" not "N-N")
  let selectionRange = ''
  if (selection) {
    selectionRange = selection.startLine === selection.endLine
      ? `${selection.startLine}`
      : `${selection.startLine}-${selection.endLine}`
  }
  const selectionLabel = selection ? `${relativePath}:${selectionRange}` : ''
  const isSelectionAttached = isActiveEditorSelectionAttached(attachedFiles, filePath, selectionLabel)

  // Nothing to show — file is already attached and there's no (or already-attached) selection
  if (isFileAttached && (!selection || isSelectionAttached)) return null;

  const ext = fileName.split('.').pop() || '';
  // Always show only the filename in the suggestion UI
  const displayName = fileName;

  const handleAddFile = () => {
    onAddVSCodeFile(filePath, fileName, fileSize);
    setPendingInputText(attachmentCitationDisplay(fileName), 'append-inline');
  };

  const handlePinSelection = async () => {
    if (!selection) return;
    const blob = new Blob([selection.text], { type: 'text/plain' });
    const file = new File([blob], selectionLabel, { type: 'text/plain' });
    await onAddVSCodeSelection(filePath, file);
    setPendingInputText(attachmentCitationDisplay(selectionLabel), 'append-inline');
  };

  // If there is a selection, prefer showing the pin-selection UI only.
  const showSelectionPin = !!selection && !isSelectionAttached;
  const showFileAdd = !showSelectionPin && !isFileAttached;

  if (!showSelectionPin && !showFileAdd) return null;

  return (
    <div className="inline-flex items-center">
      {showSelectionPin && (
        <div
          className="inline-flex items-center gap-1 text-xs pr-1 rounded-sm italic text-muted-foreground border border-dashed bg-transparent"
          style={{ borderColor: 'var(--syntax-punctuation)' }}
          title={relativePath}
        >
          <button
            type="button"
            title={t('chat.fileAttachment.activeEditor.pinSelection')}
            aria-label={t('chat.fileAttachment.activeEditor.pinSelection')}
            onClick={() => { void handlePinSelection(); }}
            className="flex items-center justify-center h-5 w-5 flex-shrink-0 hover:bg-[var(--interactive-hover)] rounded-full transition-colors cursor-pointer"
          >
            <Icon name="pushpin-2" className="h-4 w-4" />
          </button>
          <FileTypeIcon filePath={fileName} extension={ext} className="h-4 w-4 flex-shrink-0" />
          <span className="text-xs whitespace-nowrap">{`${displayName}:${selectionRange}`}</span>
        </div>
      )}
      {showFileAdd && (
        <div
          className="inline-flex items-center gap-1 text-xs pr-1 rounded-sm italic text-muted-foreground border border-dashed bg-transparent"
          style={{ borderColor: 'var(--syntax-punctuation)' }}
          title={relativePath}
        >
          <button
            type="button"
            title={t('chat.fileAttachment.activeEditor.addFile', { name: displayName })}
            aria-label={t('chat.fileAttachment.activeEditor.addFile', { name: displayName })}
            onClick={handleAddFile}
            className="flex items-center justify-center h-5 w-5 flex-shrink-0 hover:bg-[var(--interactive-hover)] rounded-full transition-colors cursor-pointer"
          >
            <Icon name="add" className="h-4 w-4" />
          </button>
          <FileTypeIcon filePath={fileName} extension={ext} className="h-4 w-4 flex-shrink-0" />
          <span className="text-xs truncate max-w-[220px]">{displayName}</span>
        </div>
      )}
    </div>
  );
});

ActiveEditorFileSuggestion.displayName = 'ActiveEditorFileSuggestion';

interface FilePart {
  id?: string;
  messageID?: string;
  sessionID?: string;
  type: string;
  mime?: string;
  url?: string;
  filename?: string;
  size?: number;
  byteSize?: number;
  source?: Record<string, unknown>;
  slim?: boolean;
}

const GITHUB_ISSUE_LINK_MIME = 'application/vnd.github.issue-link';
const GITHUB_PR_LINK_MIME = 'application/vnd.github.pull-request-link';

const getGitHubLinkKind = (file: FilePart): 'issue' | 'pr' | null => {
  if (file.mime === GITHUB_ISSUE_LINK_MIME) {
    return 'issue';
  }
  if (file.mime === GITHUB_PR_LINK_MIME) {
    return 'pr';
  }
  return null;
};

interface MessageFilesDisplayProps {
  files: FilePart[];
  messageID: string;
  sessionID?: string;
  onShowPopup?: (content: ToolPopupContent) => void;
  compact?: boolean;
}

// eslint-disable-next-line react-refresh/only-export-components -- Stable identity contract is covered by focused tests.
export const filePartDedupeKey = (file: FilePart): string => {
  const partID = typeof file.id === 'string' ? file.id.trim() : '';
  if (partID) return `part:${partID}`;
  const filename = typeof file.filename === 'string' ? file.filename.trim().toLowerCase() : '';
  const mime = typeof file.mime === 'string' ? file.mime.trim().toLowerCase() : '';
  // Image optimistic parts often keep a data: URL while the server echo uses a
  // different locator for the same attachment — prefer filename identity there.
  if (mime.startsWith('image/') && filename) return `image:${filename}|${mime}`;
  const url = typeof file.url === 'string' ? file.url.trim() : '';
  if (url) return `url:${url}`;
  return `meta:${filename}|${mime}|${file.size ?? ''}`;
};

// eslint-disable-next-line react-refresh/only-export-components -- Pure helper is tested directly.
export const dedupeMessageFileParts = (files: FilePart[]): FilePart[] => {
  const indexes = new Map<string, number>();
  const next: FilePart[] = [];
  for (const file of files) {
    if (
      file.type !== 'file'
      || !(file.mime || file.url)
      || isCodeSelectionFilePart(file)
    ) {
      continue;
    }
    const key = filePartDedupeKey(file);
    const existingIndex = indexes.get(key);
    if (existingIndex === undefined) {
      indexes.set(key, next.length);
      next.push(file);
      continue;
    }
    if (next[existingIndex]?.slim === true && file.slim !== true) {
      next[existingIndex] = file;
    }
  }
  return next;
};

/**
 * Timeline entries keep first-paint parts. On-demand `session.message` fills
 * land in Query; upgrade matching slim images in place. Never append extra
 * live file parts — assistant tool rows would otherwise render as unnamed files.
 */
// eslint-disable-next-line react-refresh/only-export-components -- Pure helper is tested directly.
export const resolveMessageDisplayFiles = (
  propFiles: FilePart[],
  liveParts: readonly { type?: string; id?: string; slim?: boolean; url?: string; filename?: string }[],
): FilePart[] => {
  const liveByID = new Map<string, FilePart>();
  const liveByName = new Map<string, FilePart>();
  for (const part of liveParts) {
    if (part.type !== 'file' || part.slim === true || typeof part.url !== 'string' || !part.url) continue;
    const live = part as FilePart;
    if (typeof part.id === 'string' && part.id) liveByID.set(part.id, live);
    if (typeof part.filename === 'string' && part.filename) liveByName.set(part.filename, live);
  }
  if (liveByID.size === 0 && liveByName.size === 0) return dedupeMessageFileParts(propFiles);
  const upgraded = propFiles.map((file) => {
    if (file.type !== 'file') return file;
    if (typeof file.url === 'string' && file.url && file.slim !== true) return file;
    if (file.id && liveByID.has(file.id)) return liveByID.get(file.id) ?? file;
    if (file.filename && liveByName.has(file.filename)) return liveByName.get(file.filename) ?? file;
    return file;
  });
  return dedupeMessageFileParts(upgraded);
};

/** Visible slim-image slot status. Query `ready` with a still-slim snapshot is not a failure. */
// eslint-disable-next-line react-refresh/only-export-components -- Pure helper is tested directly.
export const resolveSlimImageMaterializationStatus = (input: {
  hasSlimImage: boolean;
  flightActive: boolean;
  failed: boolean;
  repositoryStatus: 'idle' | 'loading' | 'ready' | 'error';
}): 'idle' | 'loading' | 'ready' | 'error' => {
  if (input.failed || input.repositoryStatus === 'error') return 'error';
  if (input.flightActive || input.repositoryStatus === 'loading') return 'loading';
  if (input.hasSlimImage && input.repositoryStatus === 'ready') return 'idle';
  return input.repositoryStatus;
};

/** Image URLs that render without a runtime file-stream fetch (never relay-gated). */
// eslint-disable-next-line react-refresh/only-export-components -- Pure helper is tested directly.
export const isDirectImageUrl = (url: string): boolean => /^(?:data|blob|https?):/i.test(url);

/** Best-known byte size of an image part: measured `byteSize` first, declared `size` second. */
// eslint-disable-next-line react-refresh/only-export-components -- Pure helper is tested directly.
export const filePartImageKnownBytes = (file: FilePart): number | undefined => {
  for (const value of [file.byteSize, file.size]) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
};

/**
 * A slim (url-less) oversized image defers whole-message materialization over
 * the relay until the user taps load — the exact record fetch carries the
 * inline data URL for every slim part of that message.
 */
// eslint-disable-next-line react-refresh/only-export-components -- Pure helper is tested directly.
export const messageSlimImageManualLoadRequired = (transportIdentity: string, files: FilePart[]): boolean => (
  files.some((file) => (
    file.type === 'file'
    && file.mime?.startsWith('image/') === true
    && file.slim === true
    && !file.url
    && imageRequiresManualLoadOverRelay(transportIdentity, filePartImageKnownBytes(file))
  ))
);

/** A full (url-carrying) image fetched through the runtime file stream is relay-gated by known size. */
// eslint-disable-next-line react-refresh/only-export-components -- Pure helper is tested directly.
export const filePartImageManualLoadRequired = (transportIdentity: string, file: FilePart): boolean => {
  if (file.type !== 'file' || file.mime?.startsWith('image/') !== true) return false;
  if (typeof file.url !== 'string' || !file.url || isDirectImageUrl(file.url)) return false;
  return imageRequiresManualLoadOverRelay(transportIdentity, filePartImageKnownBytes(file));
};

const getMessageImageGridClassName = (imageCount: number) => cn(
  'grid gap-2',
  imageCount === 1 ? 'grid-cols-1 max-w-56' : 'grid-cols-2',
);

const MessageImageCard = ({
  source,
  filename,
  sizeText,
  onOpen,
  materializationStatus = 'ready',
  onRetry,
}: {
  source?: string;
  filename: string;
  sizeText: string;
  onOpen?: () => void;
  materializationStatus?: 'idle' | 'loading' | 'ready' | 'error';
  onRetry?: () => void;
}) => {
  const { t } = useI18n();
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const displaySource = useResolvedImageSource(source ?? '', effectiveDirectory);
  return (
    <div
      className="relative aspect-square min-w-0 overflow-hidden rounded-lg border border-border/40 bg-muted/10"
      data-message-image-slot="true"
    >
      {source ? (
        <button
          type="button"
          onClick={onOpen}
          className="group absolute inset-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
          aria-label={filename}
        >
          <img src={displaySource || undefined} alt={filename} className="h-full w-full object-cover" loading="lazy" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          <div className="absolute bottom-0 left-0 right-0 p-2 text-white opacity-0 group-hover:opacity-100 transition-opacity">
            <p className="text-xs font-medium truncate">{filename}</p>
            {sizeText && <p className="text-xs opacity-80">{sizeText}</p>}
          </div>
        </button>
      ) : (
        <div
          className={cn(
            'absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center typography-meta text-muted-foreground',
            materializationStatus === 'error' && 'text-[var(--status-error)]',
          )}
          role={materializationStatus === 'error' ? 'alert' : 'status'}
          aria-label={filename}
        >
          {materializationStatus === 'loading' ? (
            <Icon name="loader-4" className="size-5 animate-spin" aria-hidden="true" />
          ) : (
            <Icon name={materializationStatus === 'error' ? 'error-warning' : 'file-image'} className="size-5" aria-hidden="true" />
          )}
          <span>
            {materializationStatus === 'loading'
              ? t('chat.fileAttachment.image.loading')
              : materializationStatus === 'error'
                ? t('chat.fileAttachment.image.loadFailed')
                : filename}
          </span>
          {materializationStatus === 'error' && onRetry ? (
            <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
              {t('chat.fileAttachment.image.retry')}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
};

const MessageManualImageLoadGroup = ({
  images,
  onLoad,
}: {
  images: Array<{ key: string; filename: string; sizeText: string }>;
  onLoad: (key: string) => void;
}) => {
  const { t } = useI18n();
  const actionLabel = t('chat.fileAttachment.image.loadManually');

  return (
    <div className="col-span-full flex flex-col gap-1.5" data-manual-image-load-group="true">
      {images.map((image) => (
        <Button
          key={image.key}
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onLoad(image.key)}
          aria-label={actionLabel}
          className="group h-auto min-h-8 min-w-0 justify-start gap-2 whitespace-normal border border-border/30 bg-muted/60 px-2 py-1.5 text-left hover:bg-[var(--interactive-hover)]"
          data-manual-image-load-item={image.key}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/40 bg-background/70 text-muted-foreground transition-colors group-hover:text-foreground">
            <Icon name="file-image" className="size-4" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate typography-meta text-foreground">{image.filename}</span>
            {image.sizeText && <span className="block text-xs leading-tight text-muted-foreground">{image.sizeText}</span>}
          </span>
        </Button>
      ))}
    </div>
  );
};

const MESSAGE_IMAGE_VISIBILITY_OPTIONS = { threshold: 0.01 } as const;

/** Stable empty gate set so ungated rows keep referential equality across renders. */
const EMPTY_IMAGE_GATE_KEYS: ReadonlySet<string> = new Set<string>();

export const MessageFilesDisplay = memo(({ files, messageID, sessionID, onShowPopup, compact = false }: MessageFilesDisplayProps) => {
  const { t } = useI18n();
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const resolvedSessionID = sessionID
    || files.find((file) => typeof file.sessionID === 'string' && file.sessionID)?.sessionID
    || '';
  const liveParts = useSessionParts(messageID, effectiveDirectory, resolvedSessionID || undefined);
  const [fetchedParts, setFetchedParts] = React.useState<readonly { type?: string; id?: string; slim?: boolean; url?: string; filename?: string }[]>(
    () => getLastFetchedSessionMessageParts(messageID) ?? [],
  );
  const hydrationRootRef = React.useRef<HTMLDivElement>(null);
  const autoRequestedRef = React.useRef(false);
  const materializationFlightRef = React.useRef<Promise<void> | null>(null);
  const materializationFailedRef = React.useRef(false);
  const projectedImageSlotKeysRef = React.useRef(new Set<string>());
  const hydrationScopeRef = React.useRef('');
  const [, bumpMaterializationRevision] = React.useReducer((value: number) => value + 1, 0);
  const hydrationScope = `${effectiveDirectory}\n${resolvedSessionID}\n${messageID}`;
  if (hydrationScopeRef.current !== hydrationScope) {
    hydrationScopeRef.current = hydrationScope;
    autoRequestedRef.current = false;
    materializationFlightRef.current = null;
    materializationFailedRef.current = false;
    projectedImageSlotKeysRef.current = new Set<string>();
    setFetchedParts(getLastFetchedSessionMessageParts(messageID) ?? []);
  }
  for (const file of files) {
    if (file.type === 'file' && file.slim === true && file.mime?.startsWith('image/')) {
      projectedImageSlotKeysRef.current.add(filePartDedupeKey(file));
    }
  }

  const extractFilename = (path?: string): string => {
    if (!path) return 'Unnamed file';

    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/');
    const filename = parts[parts.length - 1];

    return filename || path;
  };

  const resolveDisplayName = React.useMemo(
    () => (file: FilePart): string => {
      const isGitHubLink = getGitHubLinkKind(file) !== null;
      if (isGitHubLink && typeof file.filename === 'string' && file.filename.trim().length > 0) {
        return file.filename.trim();
      }
      return extractFilename(file.filename || file.url) || t('chat.fileAttachment.fileFallback');
    },
    [t],
  );

  const formatFileSize = (bytes?: number) => {
    if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Guard against optimistic+server part races that leave two file parts for one attachment.
  const dedupedFileItems = React.useMemo(
    () => resolveMessageDisplayFiles(files, [...liveParts, ...fetchedParts]),
    [fetchedParts, files, liveParts],
  );

  const transportIdentity = useRuntimeTransportIdentity();
  // Relay size gate: an oversized slim image defers whole-message materialization,
  // and an oversized file-stream image defers its own byte fetch, until a tap.
  const slimManualLoadRequired = React.useMemo(
    () => messageSlimImageManualLoadRequired(transportIdentity, dedupedFileItems),
    [dedupedFileItems, transportIdentity],
  );
  const [approvedImageLoad, setApprovedImageLoad] = React.useState<{ scope: string; keys: ReadonlySet<string> }>({
    scope: '',
    keys: EMPTY_IMAGE_GATE_KEYS,
  });
  const approvedImageKeys = approvedImageLoad.scope === hydrationScope
    ? approvedImageLoad.keys
    : EMPTY_IMAGE_GATE_KEYS;
  const gatedImageKeys = React.useMemo(() => {
    if (!isRelayTransport(transportIdentity)) return EMPTY_IMAGE_GATE_KEYS;
    const keys = new Set<string>();
    for (const file of dedupedFileItems) {
      const key = filePartDedupeKey(file);
      if (approvedImageKeys.has(key)) continue;
      if (filePartImageManualLoadRequired(transportIdentity, file)) keys.add(key);
    }
    return keys;
  }, [approvedImageKeys, dedupedFileItems, transportIdentity]);

  const imageFiles = dedupedFileItems.filter(f => f.mime?.startsWith('image/'));
  const fullImageFiles = imageFiles.filter((file) => Boolean(file.url));
  const otherFiles = dedupedFileItems.filter(f => !f.mime?.startsWith('image/'));
  const hasSlimImage = imageFiles.some((file) => file.slim === true);
  const slimImageLoadGateActive = slimManualLoadRequired
    && imageFiles.some((file) => file.slim === true && !approvedImageKeys.has(filePartDedupeKey(file)));
  const manualImageFiles = imageFiles.filter((file) => {
    const key = filePartDedupeKey(file);
    if (approvedImageKeys.has(key)) return false;
    if (file.slim === true) return slimManualLoadRequired;
    return gatedImageKeys.has(key);
  });
  const manualImageKeys = new Set(manualImageFiles.map(filePartDedupeKey));
  const compactGridImageFiles = imageFiles.filter((file) => {
    const key = filePartDedupeKey(file);
    return !manualImageKeys.has(key)
      && (projectedImageSlotKeysRef.current.has(key) || Boolean(file.url));
  });
  const manualImageLoadItems = manualImageFiles.map((file) => ({
    key: filePartDedupeKey(file),
    filename: resolveDisplayName(file),
    sizeText: formatFileSize(filePartImageKnownBytes(file)),
  }));

  const requestImageMaterialization = useEvent((retry = false) => {
    if (!hasSlimImage || !effectiveDirectory || !resolvedSessionID || !messageID) return;
    if (!retry && autoRequestedRef.current) return;
    if (materializationFlightRef.current) return;

    autoRequestedRef.current = true;
    materializationFailedRef.current = false;
    const flight = materializeTranscriptMessage(effectiveDirectory, resolvedSessionID, messageID)
      .then(() => {
        const parts = getLastFetchedSessionMessageParts(messageID);
        if (parts && parts.length > 0) setFetchedParts(parts);
      })
      .catch(() => {
        const parts = getLastFetchedSessionMessageParts(messageID);
        if (parts && parts.length > 0) {
          setFetchedParts(parts);
          return;
        }
        materializationFailedRef.current = true;
      })
      .finally(() => {
        materializationFlightRef.current = null;
        bumpMaterializationRevision();
      });
    materializationFlightRef.current = flight;
    bumpMaterializationRevision();
  });

  const approveManualImageLoad = useEvent((key: string) => {
    setApprovedImageLoad((previous) => {
      const keys = previous.scope === hydrationScope ? new Set(previous.keys) : new Set<string>();
      keys.add(key);
      return { scope: hydrationScope, keys };
    });
    if (hasSlimImage) requestImageMaterialization(true);
  });

  useIntersectionObserver(
    hasSlimImage && !slimImageLoadGateActive ? hydrationRootRef : null,
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        requestImageMaterialization(false);
      }
    },
    MESSAGE_IMAGE_VISIBILITY_OPTIONS,
  );

  React.useEffect(() => {
    if (!hasSlimImage) return;
    if (slimImageLoadGateActive) return;
    const element = hydrationRootRef.current;
    if (!element) return;
    const root = element.closest('[data-scrollbar="chat"]');
    if (!root || typeof IntersectionObserver === 'undefined') {
      requestImageMaterialization(false);
      return;
    }
    const er = element.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    if (er.bottom > rr.top && er.top < rr.bottom) {
      requestImageMaterialization(false);
    }
  }, [effectiveDirectory, hasSlimImage, messageID, resolvedSessionID, slimImageLoadGateActive]); // eslint-disable-line react-hooks/exhaustive-deps -- semantic scope deps; useEvent identity never controls reruns.

  const repositoryMaterializationStatus = hasSlimImage && effectiveDirectory && resolvedSessionID
    ? getTranscriptMessageMaterializationState(effectiveDirectory, resolvedSessionID, messageID).status
    : 'ready';
  const hasDisplayableImage = dedupedFileItems.some((file) => (
    file.mime?.startsWith('image/') === true
    && typeof file.url === 'string'
    && file.url.length > 0
    && file.slim !== true
  ));
  const imageMaterializationStatus = hasDisplayableImage
    ? 'ready'
    : resolveSlimImageMaterializationStatus({
      hasSlimImage,
      flightActive: Boolean(materializationFlightRef.current),
      failed: materializationFailedRef.current,
      repositoryStatus: repositoryMaterializationStatus,
    });

  const imageGallery = React.useMemo(
    () =>
      fullImageFiles.flatMap((file) => {
        if (!file.url) return [];
        const filename = resolveDisplayName(file) || 'Image';
        return [{
          url: file.url,
          mimeType: file.mime,
          filename,
          size: file.size,
        }];
      }),
    [fullImageFiles, resolveDisplayName]
  );

  const handleImageClick = useEvent((targetFile: FilePart) => {
    if (!onShowPopup) {
      return;
    }

    const index = fullImageFiles.findIndex((file) => filePartDedupeKey(file) === filePartDedupeKey(targetFile));
    const file = imageGallery[index];
    if (!file?.url) return;

    const filename = file.filename || 'Image';

    onShowPopup({
      open: true,
      title: filename,
      content: '',
      metadata: {
        tool: 'image-preview',
        filename,
        mime: file.mimeType,
        size: file.size,
      },
      image: {
        url: file.url,
        mimeType: file.mimeType,
        filename,
        size: file.size,
        gallery: imageGallery,
        index,
      },
    });
  });

  if (dedupedFileItems.length === 0) return null;

  if (compact) {
    return (
      <div ref={hydrationRootRef} className="space-y-1.5 mt-1.5" data-message-files={messageID}>
        {otherFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {otherFiles.map((file) => {
              const fileName = resolveDisplayName(file);
              const ext = fileName.split('.').pop() || '';
              const sizeText = formatFileSize(file.size);
              const githubLinkKind = getGitHubLinkKind(file);
              // OpenCode marks directories with application/x-directory (or a trailing slash).
              const isDirectory = isDirectoryAttachmentMime(file.mime)
                || isDirectoryAttachmentPath(file.filename)
                || isDirectoryAttachmentPath(file.url);
              return (
                <Tooltip key={`file-${filePartDedupeKey(file)}`}>
                  <TooltipTrigger asChild>
                    {githubLinkKind && file.url ? (
                      <button
                        type="button"
                        onClick={() => {
                          void openExternalUrl(file.url || '');
                        }}
                        className="inline-flex items-center bg-muted/30 border border-border/30 typography-meta gap-1 px-2 py-0.5 rounded-lg text-foreground hover:text-primary transition-colors"
                      >
                        {githubLinkKind === 'pr' ? (
                          <Icon name="git-pull-request" className="text-muted-foreground h-3.5 w-3.5" />
                        ) : (
                          <Icon name="github" className="text-muted-foreground h-3.5 w-3.5" />
                        )}
                        <div className="overflow-hidden max-w-[220px]">
                          <span className="truncate block" title={fileName}>{fileName}</span>
                        </div>
                      </button>
                    ) : (
                      <div className="inline-flex items-center bg-muted/30 border border-border/30 typography-meta gap-1 px-2 py-0.5 rounded-lg">
                        {file.mime?.includes('pdf') ? (
                          <Icon name="file-pdf" className="text-muted-foreground h-3.5 w-3.5" />
                        ) : (
                          <FileTypeIcon filePath={fileName} extension={ext} isDirectory={isDirectory} className="text-muted-foreground h-3.5 w-3.5" />
                        )}
                        <div className="overflow-hidden max-w-[140px]">
                          <span className="truncate block" title={fileName}>{fileName}</span>
                        </div>
                      </div>
                    )}
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{fileName}{sizeText ? ` (${sizeText})` : ''}</p>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        )}

        {manualImageLoadItems.length > 0 ? (
          <MessageManualImageLoadGroup images={manualImageLoadItems} onLoad={approveManualImageLoad} />
        ) : null}

        {compactGridImageFiles.length > 0 ? (
          <div className={getMessageImageGridClassName(compactGridImageFiles.length)}>
            {compactGridImageFiles.map((file) => {
              const fileName = resolveDisplayName(file);
              return (
                <MessageImageCard
                  key={filePartDedupeKey(file)}
                  source={file.url}
                  filename={fileName}
                  sizeText={formatFileSize(filePartImageKnownBytes(file))}
                  materializationStatus={file.url ? 'ready' : imageMaterializationStatus}
                  onRetry={() => requestImageMaterialization(true)}
                  onOpen={file.url ? () => handleImageClick(file) : undefined}
                />
              );
            })}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div ref={hydrationRootRef} data-message-files={messageID} className={cn(
      "grid gap-2",
      compact ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2"
    )}>
      {manualImageLoadItems.length > 0 ? (
        <MessageManualImageLoadGroup images={manualImageLoadItems} onLoad={approveManualImageLoad} />
      ) : null}
      {dedupedFileItems.map((file) => {
        const fileName = resolveDisplayName(file);
        const isImage = file.mime?.startsWith('image/');
        const sizeText = formatFileSize(file.size);
        const githubLinkKind = getGitHubLinkKind(file);

        if (manualImageKeys.has(filePartDedupeKey(file))) return null;

        if (isImage && file.url) {
          return (
            <MessageImageCard
              key={filePartDedupeKey(file)}
              source={file.url}
              filename={fileName}
              sizeText={sizeText}
              onOpen={() => handleImageClick(file)}
            />
          );
        }

        if (isImage) {
          return (
            <MessageImageCard
              key={filePartDedupeKey(file)}
              filename={fileName}
              sizeText={sizeText}
              materializationStatus={imageMaterializationStatus}
              onRetry={() => requestImageMaterialization(true)}
            />
          );
        }

        if (githubLinkKind && file.url) {
          return (
            <Tooltip key={filePartDedupeKey(file)}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => {
                    void openExternalUrl(file.url || '');
                  }}
                  className={cn(
                    "flex items-center gap-2 p-2 rounded-lg border border-border/40 bg-muted/10 hover:bg-muted/20 transition-colors text-left",
                    compact ? "text-xs" : "text-sm"
                  )}
                >
                  <div className="flex-shrink-0">
                    {githubLinkKind === 'pr' ? (
                      <Icon name="git-pull-request" className={cn("text-muted-foreground", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                    ) : (
                      <Icon name="github" className={cn("text-muted-foreground", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{fileName}</p>
                    {sizeText && <p className="text-xs text-muted-foreground">{sizeText}</p>}
                  </div>
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{fileName}{sizeText ? ` (${sizeText})` : ''}</p>
              </TooltipContent>
            </Tooltip>
          );
        }

        const source = file.source;
        const sourceType = typeof source?.type === 'string' ? source.type : undefined;
        const sourcePath = source && typeof (source as Record<string, unknown>).path === 'string' ? (source as Record<string, unknown>).path as string : undefined;
        const filePath = sourceType === 'file' && sourcePath ? sourcePath : (file.url || '');
        const isDrawio = filePath && isDrawioFile(filePath);

        if (isDrawio) {
          return (
            <Tooltip key={filePartDedupeKey(file)}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => {
                    useUIStore.getState().navigateToDiagram(filePath);
                  }}
                  className={cn(
                    "flex items-center gap-2 p-2 rounded-lg border border-border/40 bg-muted/10 hover:bg-muted/20 transition-colors text-left cursor-pointer",
                    compact ? "text-xs" : "text-sm"
                  )}
                >
                  <Icon name="file" className={cn("text-muted-foreground shrink-0", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{fileName}</p>
                    <p className="text-xs text-status-info">{t('chat.fileAttachment.openInDiagram')}</p>
                  </div>
                  <Icon name="external-link" className={cn("text-muted-foreground shrink-0", compact ? "h-3 w-3" : "h-3.5 w-3.5")} />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('chat.fileAttachment.openInDiagram')}</p>
              </TooltipContent>
            </Tooltip>
          );
        }

        return (
          <Tooltip key={filePartDedupeKey(file)}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  if (onShowPopup && file.url) {
                    onShowPopup({
                      open: true,
                      title: fileName,
                      content: '',
                      image: {
                        url: file.url,
                        mimeType: file.mime,
                        filename: fileName,
                      },
                    });
                  }
                }}
                className={cn(
                  "flex items-center gap-2 p-2 rounded-lg border border-border/40 bg-muted/10 hover:bg-muted/20 transition-colors text-left",
                  compact ? "text-xs" : "text-sm"
                )}
              >
                <div className="flex-shrink-0">
                  {file.mime?.startsWith('image/') ? (
                    <Icon name="file-image" className={cn("text-muted-foreground", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                  ) : isDirectoryAttachmentMime(file.mime) || isDirectoryAttachmentPath(file.filename) || isDirectoryAttachmentPath(file.url) ? (
                    <FileTypeIcon
                      filePath={fileName}
                      isDirectory
                      className={cn("text-muted-foreground", compact ? "h-3.5 w-3.5" : "h-4 w-4")}
                    />
                  ) : file.mime?.includes('pdf') ? (
                    <Icon name="file-pdf" className={cn("text-muted-foreground", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                  ) : (
                    <Icon name="file" className={cn("text-muted-foreground", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{fileName}</p>
                  {sizeText && <p className="text-xs text-muted-foreground">{sizeText}</p>}
                </div>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{fileName}{sizeText ? ` (${sizeText})` : ''}</p>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
});

MessageFilesDisplay.displayName = 'MessageFilesDisplay';

interface ImageGalleryProps {
  urls: string[];
  caption?: string;
  onShowPopup?: (content: ToolPopupContent) => void;
}

const ImageGallery = memo(({ urls, caption, onShowPopup }: ImageGalleryProps) => {
  if (urls.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className={getMessageImageGridClassName(urls.length)}>
        {urls.map((url, index) => (
          <button
            key={url}
            type="button"
            onClick={() => onShowPopup?.({
              open: true,
              title: caption || `Image ${index + 1} of ${urls.length}`,
              content: '',
              image: {
                url,
                gallery: urls.map(u => ({ url: u })),
                index,
              },
            })}
            className="relative aspect-square rounded-lg border border-border/40 bg-muted/10 overflow-hidden group"
          >
            <img
              src={url}
              alt={caption || `Image ${index + 1}`}
              className="h-full w-full object-cover transition-transform group-hover:scale-105"
              loading="lazy"
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors" />
          </button>
        ))}
      </div>
      {caption && (
        <p className="text-sm text-muted-foreground italic">{caption}</p>
      )}
    </div>
  );
});

ImageGallery.displayName = 'ImageGallery';
