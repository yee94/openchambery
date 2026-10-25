import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { readFileResourceUrl, readRuntimeFileBlob } from '@/lib/runtime-file-resource';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { fileResourceBrowserUrl } from '@/lib/runtime-file-download';
import { acquireRuntimeUrlAuthToken, subscribeRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { openNativeVideoSource } from '@/lib/native-video';
import { resolveImageSource, needsRuntimeImageStream, useRuntimeTransportIdentity } from '../imageSource';
import { MediaSaveButton } from './MediaSaveButton';
import { MediaPreviewToolbar, PreviewCloseButton } from './MediaPreviewOverlay';
import type { ToolPopupContent } from './types';

export function VideoPreviewDialog({ video, onClose, isMobile }: {
  video: NonNullable<ToolPopupContent['video']>;
  onClose: () => void;
  isMobile: boolean;
}) {
  const { t } = useI18n();
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const directory = video.directory ?? effectiveDirectory;
  const transport = useRuntimeTransportIdentity();
  const resolved = resolveImageSource(video.url, directory);
  const runtimePath = needsRuntimeImageStream(resolved) ? resolved.path : '';
  const runtimeRoute = /^\/api(?=\/|[?#]|$)/.test(video.url) ? video.url : '';
  const needsBlob = Boolean(runtimePath || runtimeRoute);
  const sourceKey = `${transport}\n${directory}\n${video.url}`;
  const [nativeSource, setNativeSource] = React.useState<{ key: string; url?: string; unsupported?: boolean; error?: boolean }>();
  React.useEffect(() => {
    if (!needsBlob) return;
    const controller = new AbortController();
    let release: (() => Promise<void>) | undefined;
    void openNativeVideoSource(runtimeRoute || '/api/fs/raw', { query: runtimePath ? { path: runtimePath } : undefined }, controller.signal)
      .then(async (lease) => {
        if (controller.signal.aborted) { await lease?.release(); return; }
        release = lease?.release;
        setNativeSource({ key: sourceKey, url: lease?.url, unsupported: !lease });
      }).catch(() => { if (!controller.signal.aborted) setNativeSource({ key: sourceKey, error: true }); });
    return () => { controller.abort(); void release?.(); };
  }, [needsBlob, runtimePath, runtimeRoute, sourceKey]);
  const activeNative = nativeSource?.key === sourceKey ? nativeSource : undefined;
  const [urlRevision, setUrlRevision] = React.useState(0);
  React.useEffect(() => {
    if (!needsBlob || isRelayModeActive()) return;
    const release = acquireRuntimeUrlAuthToken();
    const stop = subscribeRuntimeUrlAuthToken(() => setUrlRevision(value => value + 1));
    return () => { stop(); release(); };
  }, [needsBlob, transport]);
  const resource = useQuery({
    queryKey: ['video-preview', transport, directory, video.url, urlRevision],
    enabled: needsBlob && activeNative?.unsupported === true,
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!isRelayModeActive()) {
        const url = await fileResourceBrowserUrl(runtimeRoute || '/api/fs/raw', runtimePath ? { path: runtimePath } : undefined);
        signal.throwIfAborted();
        return { url, blob: undefined };
      }
      // Native range bridges stream; legacy browser Relay playback requires a
      // Blob. The owner excludes oversized bytes from retention, not playback.
      const blob = runtimePath ? await readRuntimeFileBlob({ path: runtimePath, signal }) : await readFileResourceUrl(runtimeRoute, signal);
      return { blob, url: undefined };
    },
  });
  const [objectUrl, setObjectUrl] = React.useState<{ blob: Blob; url: string } | null>(null);
  React.useEffect(() => {
    if (!resource.data?.blob) return;
    const url = URL.createObjectURL(resource.data.blob);
    setObjectUrl({ blob: resource.data.blob, url });
    return () => URL.revokeObjectURL(url);
  }, [resource.data]);
  const source = needsBlob ? (activeNative?.url || resource.data?.url || (objectUrl?.blob === resource.data?.blob ? objectUrl?.url : '')) : resolved.source;
  const [failedSource, setFailedSource] = React.useState<string>();
  const failed = activeNative?.error || resource.isError || Boolean(source && failedSource === source);

  return <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4">
    <PreviewCloseButton onClose={onClose} isMobile={isMobile} />
    {!source && !failed && <p role="status">{t('common.loading')}</p>}
    {failed && <p role="alert">{t('filesView.error.readFileFailed')}</p>}
    {source && <video key={source} src={source} controls playsInline preload="metadata"
      aria-label={video.filename} className="max-h-[80dvh] w-full max-w-5xl object-contain"
      onError={() => setFailedSource(source)}
      controlsList="nodownload" onContextMenu={(event) => event.preventDefault()}
    />}
    <MediaPreviewToolbar isMobile={isMobile}><MediaSaveButton isMobile={isMobile} key={sourceKey} target={{ kind: 'video', sourceUrl: video.url,
      displayUrl: activeNative?.url || resource.data?.url ? undefined : source, filename: video.filename,
      mimeType: video.mimeType, effectiveDirectory: directory, prefetchedBlob: resource.data?.blob }} /></MediaPreviewToolbar>
  </div>;
}
