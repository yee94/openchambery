import React from 'react';
import { useEvent } from '@reactuses/core';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { createMobileLongPressController } from '@/components/ui/mobileLongPress';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { openNativeVideoSource } from '@/lib/native-video';
import { resolveImageSource, needsRuntimeImageStream, useRuntimeTransportIdentity } from '../imageSource';
import { openImageSaveActions } from '../imageSaveActionsBus';
import { PreviewCloseButton } from './MediaPreviewOverlay';
import type { ToolPopupContent } from './types';

export function VideoPreviewDialog({ video, onClose, isMobile }: {
  video: NonNullable<ToolPopupContent['video']>;
  onClose: () => void;
  isMobile: boolean;
}) {
  const { t } = useI18n();
  const directory = useEffectiveDirectory() ?? '';
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
  const resource = useQuery({
    queryKey: ['video-preview', transport, directory, video.url],
    enabled: needsBlob && activeNative?.unsupported === true,
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await runtimeFetch(runtimeRoute || '/api/fs/raw', {
        query: runtimePath ? { path: runtimePath } : undefined, signal,
      });
      if (!response.ok) throw new Error(`Video request failed (${response.status})`);
      return response.blob();
    },
  });
  const [objectUrl, setObjectUrl] = React.useState<{ blob: Blob; url: string } | null>(null);
  React.useEffect(() => {
    if (!resource.data) return;
    const url = URL.createObjectURL(resource.data);
    setObjectUrl({ blob: resource.data, url });
    return () => URL.revokeObjectURL(url);
  }, [resource.data]);
  const source = needsBlob ? (activeNative?.url || (objectUrl?.blob === resource.data ? objectUrl?.url : '')) : resolved.source;
  const [failedSource, setFailedSource] = React.useState<string>();
  const failed = activeNative?.error || resource.isError || Boolean(source && failedSource === source);
  const press = React.useMemo(() => createMobileLongPressController(), []);
  React.useEffect(() => () => press.reset(), [press, video.url]);
  const save = useEvent(() => {
    openImageSaveActions({ kind: 'video', sourceUrl: video.url, displayUrl: activeNative?.url ? undefined : source,
      filename: video.filename, mimeType: video.mimeType, effectiveDirectory: directory,
      prefetchedBlob: resource.data });
  });

  return <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4">
    <PreviewCloseButton onClose={onClose} isMobile={isMobile} />
    {!source && !failed && <p role="status">{t('common.loading')}</p>}
    {failed && <p role="alert">{t('filesView.error.readFileFailed')}</p>}
    {source && <video key={source} src={source} controls playsInline preload="metadata"
      aria-label={video.filename} className="max-h-[80dvh] w-full max-w-5xl object-contain"
      onError={() => setFailedSource(source)}
      onContextMenu={(event) => { event.preventDefault(); press.openFromContextMenu(video.url, save); }}
      onPointerDown={(event) => {
        if (!event.isPrimary) { press.reset(); return; }
        if (event.button !== 0) return;
        press.start({ pointerId: event.pointerId, key: video.url, clientX: event.clientX, clientY: event.clientY, onTrigger: save });
      }}
      onPointerMove={(event) => press.move(event.pointerId, event.clientX, event.clientY)}
      onPointerUp={(event) => press.end(event.pointerId)}
      onPointerCancel={(event) => press.cancel(event.pointerId)}
      onPointerLeave={(event) => press.cancel(event.pointerId)}
      onClickCapture={(event) => { if (press.consumeClick(video.url)) { event.preventDefault(); event.stopPropagation(); } }}
    />}
    <Button variant="secondary" size="sm" onClick={save}>
      <Icon name="download" className="size-4" />{t('filesView.editor.saveFile')}
    </Button>
  </div>;
}
