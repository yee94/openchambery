import { runtimeFetch } from '@/lib/runtime-fetch';
import type { EditorAPI } from '@/lib/api/types';
import {
  isDesktopBinaryPath,
  isDesktopLocalOriginActive,
  isDesktopShell,
  isVSCodeRuntime,
  openDesktopPath,
} from '@/lib/desktop';
import { ensureOutsideFileGrantForDesktop } from '@/lib/outsideFileGrants';
import { getDirectoryForFilePath, isFilePathWithinDirectory, toAbsoluteFilePath } from '@/lib/path-utils';
import { getImageMimeType, isHtmlFile, isImageFile } from '@/lib/toolHelpers';
import { useUIStore } from '@/stores/useUIStore';
import type { ToolPopupContent } from './message/types';
import { isLikelyFilePath } from './fileReferenceDecorate';
import {
  isAbsoluteReferencePath,
  isLikelyFileReferencePath,
  normalizeReferencePath,
  parseFileReference,
  type ParsedFileReference,
} from './fileReferenceParser';

export type FileReferenceInfo = { exists: boolean; isBinary: boolean };

type ResolvedFileReference = ParsedFileReference & { resolvedPath: string };

export type OpenFileReferenceOptions = {
  effectiveDirectory: string;
  editor?: EditorAPI;
  preferRuntimeEditor?: boolean;
  onShowPopup?: (content: ToolPopupContent) => void;
};

export const FILE_REFERENCE_OPEN_TITLE = 'Open file';

const FILE_REFERENCE_STAT_CONCURRENCY = 4;
const FILE_REFERENCE_STAT_CACHE_MAX = 1000;
const VSCODE_FILE_REFERENCE_STAT_CACHE_MAX = 200;
const FILE_REFERENCE_LINK_LIMIT = 80;
const VSCODE_FILE_REFERENCE_LINK_LIMIT = 40;

const FILE_REFERENCE_STAT_CACHE = new Map<string, Promise<FileReferenceInfo>>();
const FILE_REFERENCE_INFO_SNAPSHOT = new Map<string, FileReferenceInfo>();
let activeFileReferenceStatCount = 0;
const pendingFileReferenceStats: Array<() => void> = [];

const getFileReferenceStatCacheMax = (): number => (
  isVSCodeRuntime() ? VSCODE_FILE_REFERENCE_STAT_CACHE_MAX : FILE_REFERENCE_STAT_CACHE_MAX
);

export const getFileReferenceLinkLimit = (): number => (
  isVSCodeRuntime() ? VSCODE_FILE_REFERENCE_LINK_LIMIT : FILE_REFERENCE_LINK_LIMIT
);

const rememberFileReferenceInfo = (normalizedPath: string, info: FileReferenceInfo): void => {
  FILE_REFERENCE_INFO_SNAPSHOT.set(normalizedPath, info);
};

const evictOldestStatCacheEntry = (): void => {
  const oldest = FILE_REFERENCE_STAT_CACHE.keys().next().value;
  if (typeof oldest !== 'string') {
    return;
  }
  FILE_REFERENCE_STAT_CACHE.delete(oldest);
  FILE_REFERENCE_INFO_SNAPSHOT.delete(oldest);
};

const storeStatRequest = (normalizedPath: string, request: Promise<FileReferenceInfo>): void => {
  const maxCacheEntries = getFileReferenceStatCacheMax();
  while (FILE_REFERENCE_STAT_CACHE.size >= maxCacheEntries) {
    evictOldestStatCacheEntry();
  }
  FILE_REFERENCE_STAT_CACHE.set(normalizedPath, request);
};

export const peekFileReferenceInfo = (resolvedPath: string): FileReferenceInfo | undefined => {
  const normalizedPath = normalizeReferencePath(resolvedPath);
  if (!normalizedPath) {
    return undefined;
  }
  return FILE_REFERENCE_INFO_SNAPSHOT.get(normalizedPath);
};

export const extractPathCandidateFromElement = (element: HTMLElement): string => {
  if (element.tagName.toLowerCase() === 'a') {
    const href = element.getAttribute('href')?.trim();
    if (href && isLikelyFilePath(href)) {
      return href;
    }
  }

  return (element.textContent || '').trim();
};

export const getResolvedReference = (
  rawValue: string,
  effectiveDirectory: string,
): ResolvedFileReference | null => {
  const parsed = parseFileReference(rawValue);
  if (!parsed || !isLikelyFileReferencePath(parsed.path)) {
    return null;
  }

  const resolvedPath = isAbsoluteReferencePath(parsed.path)
    ? normalizeReferencePath(parsed.path)
    : toAbsoluteFilePath(effectiveDirectory, parsed.path);
  if (!resolvedPath) {
    return null;
  }

  return {
    ...parsed,
    resolvedPath,
  };
};

export const getFileReferenceInfo = (resolvedPath: string): Promise<FileReferenceInfo> => {
  const normalizedPath = normalizeReferencePath(resolvedPath);
  if (!normalizedPath) {
    return Promise.resolve({ exists: false, isBinary: false });
  }

  const cached = FILE_REFERENCE_STAT_CACHE.get(normalizedPath);
  if (cached) {
    FILE_REFERENCE_STAT_CACHE.delete(normalizedPath);
    FILE_REFERENCE_STAT_CACHE.set(normalizedPath, cached);
    return cached;
  }

  const request = new Promise<FileReferenceInfo>((resolve) => {
    const run = () => {
      activeFileReferenceStatCount += 1;
      void runtimeFetch(`/api/fs/stat?path=${encodeURIComponent(normalizedPath)}&optional=true`, {
        method: 'GET',
        cache: 'no-store',
      })
        .then(async (response) => {
          if (!response.ok) {
            const missing = { exists: false, isBinary: false };
            rememberFileReferenceInfo(normalizedPath, missing);
            resolve(missing);
            return;
          }
          const payload = await response.json().catch(() => null) as { exists?: unknown; isBinary?: unknown } | null;
          const info = { exists: payload?.exists !== false, isBinary: payload?.isBinary === true };
          rememberFileReferenceInfo(normalizedPath, info);
          resolve(info);
        })
        .catch(() => {
          const missing = { exists: false, isBinary: false };
          rememberFileReferenceInfo(normalizedPath, missing);
          resolve(missing);
        })
        .finally(() => {
          activeFileReferenceStatCount = Math.max(0, activeFileReferenceStatCount - 1);
          pendingFileReferenceStats.shift()?.();
        });
    };

    if (activeFileReferenceStatCount < FILE_REFERENCE_STAT_CONCURRENCY) {
      run();
      return;
    }

    pendingFileReferenceStats.push(run);
  });

  storeStatRequest(normalizedPath, request);
  return request;
};

export const probeFileReference = (
  resolvedPath: string,
  effectiveDirectory: string,
): Promise<FileReferenceInfo> => {
  const canGrantOutsideFile = isDesktopShell()
    && isDesktopLocalOriginActive()
    && !isFilePathWithinDirectory(resolvedPath, effectiveDirectory);
  if (!canGrantOutsideFile) {
    return getFileReferenceInfo(resolvedPath);
  }

  const normalizedPath = normalizeReferencePath(resolvedPath);
  if (!normalizedPath) {
    return Promise.resolve({ exists: false, isBinary: false });
  }

  const cached = FILE_REFERENCE_STAT_CACHE.get(normalizedPath);
  if (cached) {
    FILE_REFERENCE_STAT_CACHE.delete(normalizedPath);
    FILE_REFERENCE_STAT_CACHE.set(normalizedPath, cached);
    return cached;
  }

  const request = isDesktopBinaryPath(resolvedPath).then((isBinary) => {
    const info = { exists: true, isBinary: isBinary === true };
    rememberFileReferenceInfo(normalizedPath, info);
    return info;
  });
  storeStatRequest(normalizedPath, request);
  return request;
};

export const shouldOfferFileReference = (
  resolvedPath: string,
  info: FileReferenceInfo,
  isMobileSurface: boolean,
): boolean => {
  if (!info.exists) {
    return false;
  }
  if (
    isMobileSurface
    && info.isBinary
    && !isImageFile(resolvedPath)
    && !isHtmlFile(resolvedPath)
  ) {
    return false;
  }
  return true;
};

const getContextDirectory = (effectiveDirectory: string, resolvedPath: string): string => {
  return effectiveDirectory || getDirectoryForFilePath(effectiveDirectory, resolvedPath);
};

export const openFileReference = async (
  rawValue: string,
  isBinary: boolean,
  options: OpenFileReferenceOptions,
): Promise<void> => {
  const resolved = getResolvedReference(rawValue, options.effectiveDirectory);
  if (!resolved) {
    return;
  }

  const isApplicationBundle = resolved.resolvedPath.toLowerCase().endsWith('.app');
  if (
    (isBinary || isApplicationBundle)
    && !isImageFile(resolved.resolvedPath)
    && !isHtmlFile(resolved.resolvedPath)
  ) {
    if (await openDesktopPath(resolved.resolvedPath)) {
      return;
    }
  }

  if (isImageFile(resolved.resolvedPath) && options.onShowPopup) {
    const filename = resolved.resolvedPath.split('/').filter(Boolean).pop() ?? resolved.resolvedPath;
    options.onShowPopup({
      open: true,
      title: filename,
      content: '',
      metadata: {
        tool: 'image-preview',
        filename,
        mime: getImageMimeType(resolved.resolvedPath),
      },
      image: {
        url: resolved.resolvedPath,
        filename,
        mimeType: getImageMimeType(resolved.resolvedPath),
      },
    });
    return;
  }

  const contextDirectory = getContextDirectory(options.effectiveDirectory, resolved.resolvedPath);
  const htmlPreview = isHtmlFile(resolved.resolvedPath);
  if (options.preferRuntimeEditor && options.editor && !htmlPreview) {
    void options.editor.openFile(
      resolved.resolvedPath,
      Number.isFinite(resolved.line ?? Number.NaN)
        ? Math.max(1, Math.trunc(resolved.line as number))
        : undefined,
      Number.isFinite(resolved.column ?? Number.NaN)
        ? Math.max(1, Math.trunc(resolved.column as number))
        : undefined,
    );
    return;
  }

  if (!isFilePathWithinDirectory(resolved.resolvedPath, options.effectiveDirectory)) {
    await ensureOutsideFileGrantForDesktop(resolved.resolvedPath, options.effectiveDirectory);
  }

  const uiStore = useUIStore.getState();
  if (htmlPreview) {
    uiStore.openContextFile(contextDirectory, resolved.resolvedPath, { viewerMode: 'preview' });
    return;
  }
  if (Number.isFinite(resolved.line ?? Number.NaN)) {
    uiStore.openContextFileAtLine(
      contextDirectory,
      resolved.resolvedPath,
      Math.max(1, Math.trunc(resolved.line as number)),
      Number.isFinite(resolved.column ?? Number.NaN)
        ? Math.max(1, Math.trunc(resolved.column as number))
        : 1,
    );
    return;
  }
  uiStore.openContextFile(contextDirectory, resolved.resolvedPath);
};

export const openFileReferenceFromElement = async (
  sourceElement: HTMLElement,
  options: OpenFileReferenceOptions,
): Promise<void> => {
  const raw = sourceElement.getAttribute('data-openchamber-file-ref') || extractPathCandidateFromElement(sourceElement);
  const isBinary = sourceElement.getAttribute('data-openchamber-file-binary') === 'true';
  await openFileReference(raw, isBinary, options);
};

export const resetFileReferenceStatCacheForTests = (): void => {
  FILE_REFERENCE_STAT_CACHE.clear();
  FILE_REFERENCE_INFO_SNAPSHOT.clear();
  activeFileReferenceStatCount = 0;
  pendingFileReferenceStats.length = 0;
};
