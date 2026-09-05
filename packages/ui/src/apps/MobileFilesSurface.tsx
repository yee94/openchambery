import React from 'react';
import { createPortal } from 'react-dom';
import { File as PierreFile } from '@pierre/diffs/react';
import { useEvent } from '@reactuses/core';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MobileSheetHeaderActions } from '@/components/ui/MobileResizableSheet';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { Icon } from '@/components/icon/Icon';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import type { ToolPopupContent } from '@/components/chat/message/types';
import { TextSelectionMenu } from '@/components/chat/message/TextSelectionMenu';
import { PIERRE_RUNTIME_BASE_CSS } from '@/components/views/PierreDiffViewer';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { ensurePierreThemeRegistered } from '@/lib/shiki/appThemeRegistry';
import { getDefaultTheme } from '@/lib/theme/themes';
import { getImageMimeType, getLanguageFromExtension, isHtmlFile, isImageFile } from '@/lib/toolHelpers';
import type { FileSearchResult } from '@/lib/api/types';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { acquireRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken, subscribeRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { useFileContentQuery, useFileDirectoryQuery, useFileSearchQuery, useFileStatWatcher } from '@/queries/fileQueries';
import { cn } from '@/lib/utils';
import { useMobileBackRoute } from '@/mobile/mobileBackNavigation';
import { attachIframeSheetOverscroll } from '@/components/ui/iframeSheetOverscroll';
import { useUIStore } from '@/stores/useUIStore';

const ToolOutputDialog = lazyWithChunkRecovery(() => import('@/components/chat/message/ToolOutputDialog'));

type MobileFilesRoute =
  | { type: 'browser'; directory: string }
  | { type: 'file'; path: string; returnDirectory: string };

const MAX_MOBILE_FILE_CHARS = 250_000;

type HtmlViewMode = 'preview' | 'source';

const normalizePath = (value?: string | null): string => (value || '').replace(/\\/g, '/').replace(/\/+$/g, '');

const getNameFromPath = (path: string): string => {
  const normalized = normalizePath(path);
  if (!normalized || normalized === '/') return normalized || '/';
  return normalized.split('/').filter(Boolean).at(-1) ?? normalized;
};

const getParentDirectory = (path: string): string | null => {
  const normalized = normalizePath(path);
  if (!normalized || normalized === '/') return null;
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return normalized.startsWith('/') ? '/' : null;
  return normalized.slice(0, index);
};

const getRelativePath = (path: string, root: string): string => {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  if (!normalizedRoot || normalizedPath === normalizedRoot) return getNameFromPath(normalizedPath);
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) return normalizedPath.slice(normalizedRoot.length + 1);
  return normalizedPath;
};

const formatFileSize = (size?: number): string => {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = size / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === units[units.length - 1]) return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
    value /= 1024;
  }
  return '';
};

const getImageSrc = (path: string): string => {
  if (path.toLowerCase().endsWith('.svg')) {
    return '';
  }
  return getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', { path });
};

const isMarkdownFile = (path: string): boolean => /\.(md|mdx|markdown)$/i.test(path);

const toFsServeRoutePath = (filePath: string): string => {
  const encoded = filePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `/api/fs/serve${encoded.startsWith('/') ? encoded : `/${encoded}`}`;
};

const buildFsServeAssetUrl = (filePath: string): string => {
  return getRuntimeUrlResolver().authenticatedAsset(toFsServeRoutePath(filePath));
};
type MobileFilesSurfaceProps = {
  /** When provided, header gets a close X that calls this; used when the surface is hosted in MobileResizableSheet / iPad right panel. */
  onClose?: () => void;
  /**
   * Absolute path to open immediately as file detail (Read tool / direct preview sheet).
   * Host should remount when the target path changes so the initial route re-seeds.
   */
  initialFilePath?: string | null;
  /**
   * When true with an initial file route, back from detail dismisses the host sheet
   * instead of returning to the browser list. Pair with hideFileHeader when the host
   * sheet already owns title + close chrome (same pattern as direct Changes diffs).
   */
  directFilePreview?: boolean;
  /** Hide the in-content file detail header; host sheet provides chrome. */
  hideFileHeader?: boolean;
};

export const MobileFilesSurface: React.FC<MobileFilesSurfaceProps> = ({
  onClose,
  initialFilePath = null,
  directFilePreview = false,
  hideFileHeader = false,
}) => {
  const { t } = useI18n();
  const { files } = useRuntimeAPIs();
  const root = normalizePath(useEffectiveDirectory() ?? null);
  const [route, setRoute] = React.useState<MobileFilesRoute>(() => {
    const focusPath = normalizePath(initialFilePath);
    if (focusPath) {
      return {
        type: 'file',
        path: focusPath,
        returnDirectory: getParentDirectory(focusPath) ?? root,
      };
    }
    return { type: 'browser', directory: root };
  });
  const mobileNavigationSurfaceRef = React.useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = React.useState('');
  const pendingFileFocusPath = useUIStore((state) => state.pendingFileFocusPath);
  const setPendingFileFocusPath = useUIStore((state) => state.setPendingFileFocusPath);

  React.useEffect(() => {
    if (!root) return;
    setRoute((current) => {
      // Never clobber a direct file preview (Read/Skill sheet) or an already
      // navigated browser directory when the project root first resolves.
      if (current.type === 'file') {
        return current.returnDirectory
          ? current
          : { ...current, returnDirectory: getParentDirectory(current.path) ?? root };
      }
      if (current.type === 'browser' && current.directory) return current;
      return { type: 'browser', directory: root };
    });
  }, [root]);

  // Respond to uiStore.openContextFile(...) issued outside this surface (for
  // example from a file-reference link inside a chat markdown message). The
  // pending focus path carries the absolute file path; route the surface
  // directly into the file detail view and clear the pending entry so the
  // same navigation is not re-applied on remount.
  React.useEffect(() => {
    if (!pendingFileFocusPath || !root) {
      return;
    }

    const targetPath = normalizePath(pendingFileFocusPath);
    if (!targetPath) {
      setPendingFileFocusPath(null);
      return;
    }

    setQuery('');
    setRoute({ type: 'file', path: targetPath, returnDirectory: getParentDirectory(targetPath) ?? root });
    setPendingFileFocusPath(null);
  }, [pendingFileFocusPath, root, setPendingFileFocusPath]);

  const currentDirectory = route.type === 'browser' ? route.directory : route.returnDirectory;
  const browserDirectory = route.type === 'browser' ? route.directory : '';
  const filePath = route.type === 'file' ? route.path : '';
  const [htmlViewMode, setHtmlViewMode] = React.useState<HtmlViewMode>('preview');
  React.useEffect(() => {
    setHtmlViewMode('preview');
  }, [filePath]);
  const debouncedQuery = useDebouncedValue(query, 250);
  const normalizedQuery = query.trim();
  const normalizedDebouncedQuery = debouncedQuery.trim();

  const directoryQuery = useFileDirectoryQuery({
    scopeDirectory: root,
    directory: browserDirectory,
  }, {
    enabled: Boolean(browserDirectory),
    refetchOnMount: 'always',
  });

  const searchQuery = useFileSearchQuery({
    directory: browserDirectory,
    query: normalizedDebouncedQuery,
    maxResults: 40,
  }, {
    enabled: Boolean(browserDirectory && normalizedDebouncedQuery),
  });

  const shouldReadFile = Boolean(
    filePath
    && files.readFile
    && (!isHtmlFile(filePath) || htmlViewMode === 'source')
    && (!isImageFile(filePath) || filePath.toLowerCase().endsWith('.svg')),
  );
  const fileQuery = useFileContentQuery({
    scopeDirectory: root,
    path: filePath,
  }, {
    enabled: shouldReadFile,
  });
  // Read-only preview: watch for external changes (agent edits the file being
  // viewed) and refetch content when stat moves. Scroll position is preserved
  // because the preview container is not remounted on content updates.
  useFileStatWatcher({
    scopeDirectory: root,
    path: filePath,
  }, {
    enabled: shouldReadFile,
  });

  const entries = directoryQuery.data?.entries.slice().sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  }) ?? [];
  const directoryError = directoryQuery.error
    ? directoryQuery.error instanceof Error ? directoryQuery.error.message : t('mobile.files.error.listFailed')
    : null;
  const isLoadingDirectory = directoryQuery.isFetching;
  const searchResults = searchQuery.data ?? [];
  const isSearching = Boolean(normalizedQuery && normalizedDebouncedQuery && query === debouncedQuery && searchQuery.isFetching);
  const fileContent = fileQuery.data && fileQuery.data.length > MAX_MOBILE_FILE_CHARS
    ? `${fileQuery.data.slice(0, MAX_MOBILE_FILE_CHARS)}\n\n${t('mobile.files.file.truncated')}`
    : fileQuery.data ?? '';
  const fileError = filePath && !files.readFile
    ? t('mobile.files.error.readUnavailable')
    : fileQuery.error
      ? fileQuery.error instanceof Error ? fileQuery.error.message : t('filesView.error.readFileFailed')
      : null;
  const isLoadingFile = shouldReadFile && fileQuery.isFetching;

  const openDirectory = (directory: string) => {
    setQuery('');
    setRoute({ type: 'browser', directory });
  };

  const openFile = (path: string) => {
    setRoute({ type: 'file', path, returnDirectory: currentDirectory || root });
  };

  const closeFileDetail = useEvent(() => {
    if (route.type !== 'file') return false;
    // Direct Read/Skill preview: dismiss the host gesture sheet instead of
    // dropping into the project browser (mirrors direct Changes diffs).
    if (directFilePreview) {
      onClose?.();
      return true;
    }
    setRoute({ type: 'browser', directory: route.returnDirectory });
    return true;
  });

  useMobileBackRoute({
    id: 'mobile-files-detail',
    active: route.type === 'file',
    layer: 'overlay',
    onBack: closeFileDetail,
    surfaceRef: mobileNavigationSurfaceRef,
  });

  const handleCopyPath = async (path: string) => {
    const result = await copyTextToClipboard(path);
    if (!result.ok) toast.error(t('mobile.files.toast.copyFailed'));
  };

  const handleCopyContent = async () => {
    const result = await copyTextToClipboard(fileContent);
    if (result.ok) toast.success(t('mobile.files.toast.contentCopied'));
    else toast.error(t('mobile.files.toast.copyFailed'));
  };

  if (!root) {
    return <MobileFilesState message={t('mobile.files.empty.noDirectory')} />;
  }

  if (route.type === 'file') {
    return (
      <div ref={mobileNavigationSurfaceRef} className="flex h-full min-h-0 flex-col">
        <MobileFileDetail
          path={route.path}
          content={fileContent}
          error={fileError}
          isLoading={isLoadingFile}
          hideHeader={hideFileHeader}
          htmlViewMode={htmlViewMode}
          onHtmlViewModeChange={setHtmlViewMode}
          onBack={closeFileDetail}
          onCopyPath={() => void handleCopyPath(route.path)}
          onCopyContent={() => void handleCopyContent()}
        />
      </div>
    );
  }

  const directoryLabel = route.directory === root ? t('mobile.files.rootDirectory') : getNameFromPath(route.directory);
  const visibleSearchResults = query.trim() ? searchResults : [];

  // Cap parent navigation at the project root: only allow stepping up while
  // the parent stays inside (or equal to) the root.
  const rawParent = getParentDirectory(route.directory);
  const parentWithinRoot =
    route.directory !== root && rawParent !== null && (rawParent === root || rawParent.startsWith(`${root}/`));
  const canGoBack = parentWithinRoot && !query.trim();
  const parentDirectory = parentWithinRoot ? rawParent : null;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 px-3 text-foreground">
        {onClose ? (
          <button
            type="button"
            className="-ml-1 flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('mobile.surface.closeAria')}
            onClick={onClose}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="close" className="size-5" />
          </button>
        ) : null}
        {canGoBack && parentDirectory ? (
          <button
            type="button"
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('mobile.files.backToParentAria', { name: getNameFromPath(parentDirectory) })}
            onClick={() => openDirectory(parentDirectory)}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="arrow-left" className="size-5" />
          </button>
        ) : null}
        <div className="min-w-0 flex-1 px-1">
          <h2 className="truncate typography-ui-label text-foreground">{directoryLabel}</h2>
        </div>
        <button
          type="button"
          className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={t('mobile.files.refreshAria')}
          onClick={() => void directoryQuery.refetch()}
          style={{ touchAction: 'manipulation' }}
        >
          <Icon name="refresh" className={cn('size-5', isLoadingDirectory && 'animate-spin')} />
        </button>
      </header>
      <div className="shrink-0 px-4 pb-2 pt-1" data-mobile-sheet-no-dismiss="">
        <div className="relative">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            inputMode="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('mobile.files.search.placeholder')}
            className="h-11 pl-9"
          />
        </div>
      </div>

      <ScrollShadow className="overlay-scrollbar-container min-h-0 flex-1 overflow-y-auto px-4 pb-3">
        {directoryError ? (
          <MobileFilesState message={directoryError} />
        ) : query.trim() ? (
          <MobileSearchResults results={visibleSearchResults} isSearching={isSearching} onOpenFile={openFile} />
        ) : (
          <div className="overflow-hidden rounded-2xl border border-border/40 bg-[var(--surface-elevated)]">
            {entries.length === 0 && !isLoadingDirectory ? (
              <div className="px-4 py-8 text-center typography-body text-muted-foreground">{t('mobile.files.empty.directory')}</div>
            ) : null}
            {entries.map((entry) => (
              <MobileFileRow
                key={entry.path}
                name={entry.name}
                path={entry.path}
                directory={entry.isDirectory}
                meta={entry.isDirectory ? undefined : formatFileSize(entry.size)}
                onClick={() => entry.isDirectory ? openDirectory(entry.path) : openFile(entry.path)}
              />
            ))}
          </div>
        )}
      </ScrollShadow>
    </div>
  );
};

const MobileFileRow: React.FC<{
  name: string;
  path: string;
  directory: boolean;
  meta?: string;
  onClick: () => void;
}> = ({ name, path, directory, meta, onClick }) => (
  <button
    type="button"
    className="flex min-h-14 w-full items-center gap-3 border-b border-border/30 px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
    onClick={onClick}
    style={{ touchAction: 'manipulation' }}
  >
    {directory ? (
      <Icon name="folder-3-fill" className="size-5 shrink-0 text-muted-foreground" />
    ) : (
      <FileTypeIcon filePath={path} className="size-5 shrink-0" />
    )}
    <span className="block min-w-0 flex-1 truncate typography-ui-label text-foreground">{name}</span>
    {meta ? <span className="shrink-0 typography-micro text-muted-foreground">{meta}</span> : null}
    {directory ? <Icon name="arrow-right-s" className="size-4 shrink-0 text-muted-foreground/60" /> : null}
  </button>
);

const MobileSearchResults: React.FC<{
  results: FileSearchResult[];
  isSearching: boolean;
  onOpenFile: (path: string) => void;
}> = ({ results, isSearching, onOpenFile }) => {
  const { t } = useI18n();
  const root = normalizePath(useEffectiveDirectory() ?? null);
  if (isSearching) return <MobileFilesState loading message={t('common.loading')} />;
  if (results.length === 0) return <MobileFilesState message={t('mobile.files.search.empty')} />;
  return (
    <div className="overflow-hidden rounded-2xl border border-border/40 bg-[var(--surface-elevated)]">
      {results.map((result) => (
        <MobileFileRow
          key={result.path}
          name={getNameFromPath(result.path)}
          path={result.path}
          directory={false}
          meta={getRelativePath(result.path, root)}
          onClick={() => onOpenFile(result.path)}
        />
      ))}
    </div>
  );
};

const MobileFileDetailActions: React.FC<{
  path: string;
  htmlViewMode: HtmlViewMode;
  htmlFullscreen: boolean;
  onToggleHtmlViewMode: () => void;
  onEnterHtmlFullscreen: () => void;
  onCopyPath: () => void;
  onCopyContent: () => void;
}> = ({
  path,
  htmlViewMode,
  htmlFullscreen,
  onToggleHtmlViewMode,
  onEnterHtmlFullscreen,
  onCopyPath,
  onCopyContent,
}) => {
  const { t } = useI18n();
  const html = isHtmlFile(path);

  return (
    <>
      {html ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onToggleHtmlViewMode}
            aria-label={htmlViewMode === 'preview' ? t('mobile.files.html.viewSourceAria') : t('mobile.files.html.viewPreviewAria')}
          >
            <Icon name={htmlViewMode === 'preview' ? 'file-code' : 'eye'} className="size-4" />
          </Button>
          {htmlFullscreen ? null : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onEnterHtmlFullscreen}
              aria-label={t('mobile.files.html.fullscreenAria')}
            >
              <Icon name="fullscreen" className="size-4" />
            </Button>
          )}
        </>
      ) : null}
      {!isImageFile(path) && !html ? (
        <Button type="button" variant="ghost" size="icon" onClick={onCopyContent} aria-label={t('mobile.files.copyContentAria')}>
          <Icon name="file-copy" className="size-4" />
        </Button>
      ) : null}
      <Button type="button" variant="ghost" size="icon" onClick={onCopyPath} aria-label={t('mobile.files.copyPathAria')}>
        <Icon name="clipboard" className="size-4" />
      </Button>
    </>
  );
};

const MobileFileDetail: React.FC<{
  path: string;
  content: string;
  error: string | null;
  isLoading: boolean;
  hideHeader?: boolean;
  htmlViewMode: HtmlViewMode;
  onHtmlViewModeChange: (mode: HtmlViewMode) => void;
  onBack: () => void;
  onCopyPath: () => void;
  onCopyContent: () => void;
}> = ({
  path,
  content,
  error,
  isLoading,
  hideHeader = false,
  htmlViewMode,
  onHtmlViewModeChange,
  onBack,
  onCopyPath,
  onCopyContent,
}) => {
  const { t } = useI18n();
  // Selection actions (add to chat / new session / copy) surface for text
  // selected inside the file preview, including PierreFile's shadow DOM.
  const contentContainerRef = React.useRef<HTMLDivElement>(null);
  const imagePath = isImageFile(path) && !path.toLowerCase().endsWith('.svg') ? path : '';
  const runtimeTransportIdentity = getRuntimeTransportIdentity();
  const relayImageKey = imagePath && isRelayModeActive()
    ? `${runtimeTransportIdentity}|${imagePath}`
    : '';
  const imageAuthKey = imagePath && !relayImageKey
    ? `${runtimeTransportIdentity}|${imagePath}`
    : '';
  const [imageAuthReadyKey, setImageAuthReadyKey] = React.useState('');
  const [relayImageSrc, setRelayImageSrc] = React.useState('');
  const [relayImageError, setRelayImageError] = React.useState<string | null>(null);
  const [isRelayImageLoading, setRelayImageLoading] = React.useState(false);
  const [imagePopup, setImagePopup] = React.useState<ToolPopupContent>({
    open: false,
    title: '',
    content: '',
  });

  React.useEffect(() => {
    if (!imageAuthKey) {
      setImageAuthReadyKey('');
      return;
    }

    let cancelled = false;
    setImageAuthReadyKey('');
    void refreshRuntimeUrlAuthToken(getRuntimeApiBaseUrl())
      .then((token) => {
        if (!cancelled && token) setImageAuthReadyKey(imageAuthKey);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [imageAuthKey]);

  React.useEffect(() => {
    if (!relayImageKey) {
      setRelayImageSrc('');
      setRelayImageError(null);
      setRelayImageLoading(false);
      return;
    }

    let cancelled = false;
    let objectUrl = '';
    setRelayImageSrc('');
    setRelayImageError(null);
    setRelayImageLoading(true);

    void runtimeFetch('/api/fs/raw', { query: { path: imagePath } })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(t('filesView.error.readFileFailed'));
        }
        return response.blob();
      })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setRelayImageSrc(objectUrl);
      })
      .catch((fetchError: unknown) => {
        if (!cancelled) {
          setRelayImageError(fetchError instanceof Error ? fetchError.message : t('filesView.error.readFileFailed'));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRelayImageLoading(false);
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [imagePath, relayImageKey, t]);

  const imageAuthLoading = Boolean(imageAuthKey && imageAuthReadyKey !== imageAuthKey);
  const imageSrc = relayImageKey ? relayImageSrc : imageAuthLoading ? '' : getImageSrc(path);
  const imageError = error ?? relayImageError;
  const imageFilename = getNameFromPath(path);
  const imageDataUrl = isImageFile(path)
    ? `data:${getImageMimeType(path)};utf8,${encodeURIComponent(content)}`
    : '';
  const previewImageSrc = imageSrc || (isImageFile(path) && content ? imageDataUrl : '');

  const openImagePreview = useEvent(() => {
    // Prefer the filesystem path so the shared viewer can resolve/save via runtime stream;
    // fall back to the already-materialized display URL (relay blob / data URL).
    const url = imagePath || previewImageSrc;
    if (!url) return;
    setImagePopup({
      open: true,
      title: imageFilename,
      content: '',
      metadata: {
        tool: 'image-preview',
        filename: imageFilename,
        mime: getImageMimeType(path),
      },
      image: {
        url,
        mimeType: getImageMimeType(path),
        filename: imageFilename,
      },
    });
  });

  const handleImagePopupChange = useEvent((open: boolean) => {
    setImagePopup((previous) => (previous.open === open ? previous : { ...previous, open }));
  });

  const html = isHtmlFile(path);
  const [htmlFullscreen, setHtmlFullscreen] = React.useState(false);
  const htmlFullscreenSurfaceRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    setHtmlFullscreen(false);
  }, [path]);

  const toggleHtmlViewMode = useEvent(() => {
    onHtmlViewModeChange(htmlViewMode === 'preview' ? 'source' : 'preview');
  });
  const enterHtmlFullscreen = useEvent(() => {
    setHtmlFullscreen(true);
  });
  const exitHtmlFullscreen = useEvent(() => {
    setHtmlFullscreen(false);
    return true;
  });

  useMobileBackRoute({
    id: 'mobile-html-fullscreen',
    active: html && htmlFullscreen,
    layer: 'overlay',
    onBack: exitHtmlFullscreen,
    surfaceRef: htmlFullscreenSurfaceRef,
  });

  const fileActions = (
    <MobileFileDetailActions
      path={path}
      htmlViewMode={htmlViewMode}
      htmlFullscreen={htmlFullscreen}
      onToggleHtmlViewMode={toggleHtmlViewMode}
      onEnterHtmlFullscreen={enterHtmlFullscreen}
      onCopyPath={onCopyPath}
      onCopyContent={onCopyContent}
    />
  );

  const htmlBody = htmlViewMode === 'source'
    ? (isLoading
      ? <MobileFilesState loading message={t('filesView.state.loading')} />
      : error
        ? <MobileFilesState message={error} />
        : <MobileTextFile path={path} content={content} />)
    : <MobileHtmlPreview path={path} />;

  const htmlViewer = html ? (
    <div
      ref={htmlFullscreenSurfaceRef}
      className={htmlFullscreen
        ? 'fixed inset-0 z-[80] flex flex-col bg-background text-foreground'
        : 'flex min-h-0 flex-1 flex-col overflow-hidden bg-background'}
    >
      {htmlFullscreen ? (
        <header className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={exitHtmlFullscreen}
            aria-label={t('mobile.files.html.exitFullscreenAria')}
            className="shrink-0 text-muted-foreground"
          >
            <Icon name="arrow-left" className="size-5" />
          </Button>
          <h2 className="min-w-0 flex-1 truncate typography-ui-header text-foreground">{imageFilename}</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={toggleHtmlViewMode}
            aria-label={htmlViewMode === 'preview' ? t('mobile.files.html.viewSourceAria') : t('mobile.files.html.viewPreviewAria')}
          >
            <Icon name={htmlViewMode === 'preview' ? 'file-code' : 'eye'} className="size-4" />
          </Button>
        </header>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden bg-background">
        {htmlBody}
      </div>
    </div>
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      {!hideHeader ? (
        <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-3 border-b border-border/50 px-3 text-foreground">
          <button
            type="button"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('header.actions.backAria')}
            onClick={onBack}
          >
            <Icon name="arrow-left" className="size-5" />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate typography-ui-header text-foreground">{imageFilename}</h2>
          </div>
          {fileActions}
        </header>
      ) : (
        <MobileSheetHeaderActions>
          {fileActions}
        </MobileSheetHeaderActions>
      )}
      <div ref={contentContainerRef} className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        {html ? (
          htmlFullscreen && typeof document !== 'undefined'
            ? createPortal(htmlViewer, document.body)
            : htmlViewer
        ) : isLoading || imageAuthLoading || isRelayImageLoading ? (
          <MobileFilesState loading message={t('filesView.state.loading')} />
        ) : imageError ? (
          <MobileFilesState message={imageError} />
        ) : isImageFile(path) && previewImageSrc ? (
          <ScrollShadow className="h-full overflow-auto p-4">
            <button
              type="button"
              className="mx-auto block max-h-full max-w-full cursor-zoom-in rounded-lg border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              onClick={openImagePreview}
              aria-label={imageFilename}
            >
              <img
                src={previewImageSrc}
                alt={imageFilename}
                className="mx-auto max-h-full max-w-full rounded-lg object-contain"
                draggable={false}
              />
            </button>
          </ScrollShadow>
        ) : (
          <MobileTextFile path={path} content={content} />
        )}
      </div>
      <TextSelectionMenu containerRef={contentContainerRef} />
      {imagePopup.open ? (
        <React.Suspense fallback={null}>
          <ToolOutputDialog
            popup={imagePopup}
            onOpenChange={handleImagePopupChange}
            isMobile
          />
        </React.Suspense>
      ) : null}
    </div>
  );
};

const MobileHtmlPreview: React.FC<{ path: string }> = ({ path }) => {
  const { t } = useI18n();
  const relay = isRelayModeActive();
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  const [readyKey, setReadyKey] = React.useState('');
  const [nonce, setNonce] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [relaySrcDoc, setRelaySrcDoc] = React.useState('');

  React.useEffect(() => {
    let cancelled = false;
    setReadyKey('');
    setError(null);
    setRelaySrcDoc('');

    // Iframe `src` is browser navigation and cannot cross the relay tunnel.
    // Fetch the document through runtimeFetch and inline it, same as VS Code.
    if (relay) {
      void runtimeFetch(toFsServeRoutePath(path))
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(t('filesView.error.readFileFailed'));
          }
          return response.text();
        })
        .then((html) => {
          if (cancelled) return;
          setRelaySrcDoc(html);
          setReadyKey(path);
        })
        .catch((fetchError: unknown) => {
          if (cancelled) return;
          setError(fetchError instanceof Error ? fetchError.message : t('filesView.error.readFileFailed'));
          setReadyKey(path);
        });
      return () => {
        cancelled = true;
      };
    }

    const apiBaseUrl = getRuntimeApiBaseUrl();
    const release = acquireRuntimeUrlAuthToken(apiBaseUrl);
    void refreshRuntimeUrlAuthToken(apiBaseUrl)
      .then((token) => {
        if (cancelled || !token) return;
        setReadyKey(path);
        setError(null);
      })
      .catch((authError: unknown) => {
        if (cancelled) return;
        setError(authError instanceof Error ? authError.message : t('filesView.error.readFileFailed'));
        setReadyKey(path);
      });
    const unsubscribe = subscribeRuntimeUrlAuthToken(() => {
      if (cancelled) return;
      setReadyKey(path);
      setNonce((value) => value + 1);
      setError(null);
    });
    return () => {
      cancelled = true;
      release();
      unsubscribe();
    };
  }, [path, relay, t]);

  React.useEffect(() => {
    if (readyKey !== path) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    return attachIframeSheetOverscroll(iframe);
  }, [nonce, path, readyKey, relaySrcDoc]);

  if (error) {
    return <MobileFilesState message={error} />;
  }
  if (readyKey !== path) {
    return <MobileFilesState loading message={t('filesView.state.loading')} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <iframe
        ref={iframeRef}
        key={nonce}
        src={relay ? undefined : buildFsServeAssetUrl(path)}
        srcDoc={relay ? relaySrcDoc : undefined}
        className="h-full min-h-0 w-full flex-1 border-none bg-background"
        style={{ backgroundColor: 'var(--surface-background)' }}
        sandbox="allow-scripts allow-same-origin allow-forms"
        title={t('filesView.editor.htmlPreviewTitle')}
      />
    </div>
  );
};

const MobileTextFile: React.FC<{ path: string; content: string }> = ({ path, content }) => {
  const { currentTheme, availableThemes, lightThemeId, darkThemeId } = useThemeSystem();
  const lightTheme = React.useMemo(
    () => availableThemes.find((theme) => theme.metadata.id === lightThemeId) ?? getDefaultTheme(false),
    [availableThemes, lightThemeId],
  );
  const darkTheme = React.useMemo(
    () => availableThemes.find((theme) => theme.metadata.id === darkThemeId) ?? getDefaultTheme(true),
    [availableThemes, darkThemeId],
  );

  React.useEffect(() => {
    ensurePierreThemeRegistered(lightTheme);
    ensurePierreThemeRegistered(darkTheme);
  }, [darkTheme, lightTheme]);

  const pierreTheme = React.useMemo(
    () => ({ light: lightTheme.metadata.id, dark: darkTheme.metadata.id }),
    [darkTheme.metadata.id, lightTheme.metadata.id],
  );

  if (isMarkdownFile(path)) {
    return (
      <ScrollShadow className="h-full overflow-y-auto px-4 py-4">
        <SimpleMarkdownRenderer content={content} enableFileReferences={false} />
      </ScrollShadow>
    );
  }
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ScrollShadow className="min-h-0 flex-1 overflow-auto bg-[var(--syntax-base-background)]">
        <PierreFile
          file={{
            name: getNameFromPath(path),
            contents: content,
            lang: getLanguageFromExtension(path) || undefined,
          }}
          options={{
            disableFileHeader: true,
            overflow: 'wrap',
            theme: pierreTheme,
            themeType: currentTheme.metadata.variant === 'dark' ? 'dark' : 'light',
            unsafeCSS: PIERRE_RUNTIME_BASE_CSS,
          }}
          className="block min-h-full w-full"
          style={{ minHeight: '100%' }}
        />
      </ScrollShadow>
    </div>
  );
};

const MobileFilesState: React.FC<{ message: string; loading?: boolean }> = ({ message, loading = false }) => (
  <div className="flex h-full items-center justify-center px-6 text-center">
    <div className="flex max-w-sm flex-col items-center gap-2">
      {loading ? <Icon name="loader-4" className="size-5 animate-spin text-muted-foreground" /> : <Icon name="folder-open-fill" className="size-6 text-muted-foreground" />}
      <p className="typography-ui-label font-semibold text-foreground">{message}</p>
    </div>
  </div>
);
