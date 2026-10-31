import React from 'react';
import { useResolvedImageResource } from '../imageSource';
import { ImageLoadingPlaceholder } from '@/components/ui/ImageLoadingPlaceholder';
import { useI18n } from '@/lib/i18n';
import { getFittedImageSize, type ImageViewerSize } from './imageViewerTransform';

export type ImageViewerSlideState = {
    element: HTMLImageElement | null;
    source: string;
    resourceKey: string;
    naturalSize: ImageViewerSize | null;
    loaded: boolean;
    error: boolean;
};

/** A keyed slide retains its image lease and decoded element when it becomes the current slide. */
export function ImageViewerSlide({ url, directory, label, active, returnToSource, sourceElement, viewport, isMobile, position, onActiveImage }: {
    url: string;
    directory: string;
    label: string;
    active: boolean;
    returnToSource: boolean;
    sourceElement?: HTMLImageElement;
    viewport: ImageViewerSize;
    isMobile: boolean;
    position: number;
    onActiveImage: (state: ImageViewerSlideState) => void;
}) {
    const { t } = useI18n();
    const resource = useResolvedImageResource(url, directory, 'preview');
    const source = resource.source || sourceElement?.currentSrc || '';
    const displayKey = `${resource.key}\n${source}`;
    const imageRef = React.useRef<HTMLImageElement>(null);
    const [decoded, setDecoded] = React.useState<{ key: string; size: ImageViewerSize } | null>(null);
    const [failedKey, setFailedKey] = React.useState<string | null>(null);
    const naturalSize = React.useMemo(() => decoded?.key === displayKey ? decoded.size
        : sourceElement?.naturalWidth && sourceElement.naturalHeight
            ? { width: sourceElement.naturalWidth, height: sourceElement.naturalHeight } : null,
    [decoded, displayKey, sourceElement]);
    const loaded = Boolean(naturalSize);
    const error = Boolean(resource.error || failedKey === displayKey);
    const size = getFittedImageSize(naturalSize ?? viewport, {
        width: Math.max(1, viewport.width * (isMobile ? 1 : 0.8)),
        height: Math.max(1, viewport.height * (isMobile ? 1 : 0.95)),
    });

    React.useLayoutEffect(() => {
        if (active) onActiveImage({
            element: imageRef.current, source, resourceKey: resource.key, naturalSize, loaded, error,
        });
    }, [active, source, resource.key, naturalSize, loaded, error, onActiveImage]);

    return <div data-image-viewer-slide={position} aria-hidden={!active || undefined}
        className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden"
        style={{ transform: `translate3d(${position * (viewport.width + 16)}px, 0, 0)` }}>
        {!loaded && !error && <div className="absolute inset-0 flex items-center justify-center" role={active ? 'status' : undefined}>
            <ImageLoadingPlaceholder className="aspect-square w-64 max-w-[80vw] rounded-xl" />
        </div>}
        {error ? <p role={active ? 'status' : undefined} className="px-6 text-center typography-ui-label">
            {t('filesView.error.readFileFailed')}
        </p> : <img ref={imageRef}
            data-preview-transition-target={active ? '' : undefined}
            data-preview-return={returnToSource}
            src={source || undefined} alt={active ? label : ''}
            className={`block max-w-none object-contain will-change-transform ${active ? 'pointer-events-auto' : ''} ${loaded ? 'opacity-100' : 'opacity-0'}`}
            style={{ width: `${size.width}px`, height: `${size.height}px` }}
            loading="eager" draggable={false}
            onLoad={(event) => {
                const image = event.currentTarget;
                if (image.naturalWidth && image.naturalHeight) setDecoded({
                    key: displayKey, size: { width: image.naturalWidth, height: image.naturalHeight },
                });
            }}
            onError={() => setFailedKey(displayKey)} />}
    </div>;
}
