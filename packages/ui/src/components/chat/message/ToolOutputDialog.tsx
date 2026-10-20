import React from 'react';
import { useEvent } from '@reactuses/core';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { File as PierreFile, PatchDiff } from '@pierre/diffs/react';
import { WorkerHighlightedCode } from '@/components/code/WorkerHighlightedCode';

import { cn } from '@/lib/utils';
import { SimpleMarkdownRenderer } from '../MarkdownRenderer';
import { toolDisplayStyles } from '@/lib/typography';
import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { ensurePierreThemeRegistered } from '@/lib/shiki/appThemeRegistry';
import { getDefaultTheme } from '@/lib/theme/themes';
import {
    renderTodoOutput,
    renderListOutput,
    renderGrepOutput,
    renderGlobOutput,
    renderWebSearchOutput,
    formatInputForDisplay,
    parseReadToolOutput,
    tryParseJsonOutput,
} from './toolRenderers';
import type { ToolPopupContent, DiffViewMode } from './types';
import { DiffViewToggle } from './DiffViewToggle';
import { VirtualizedCodeBlock, type CodeLine } from './parts/VirtualizedCodeBlock';
import { JsonTreeView } from '@/components/ui/JsonTreeView';
import { Icon } from "@/components/icon/Icon";
import { useI18n, type I18nKey, type I18nParams } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { MermaidLoadFailure, getMermaidDataUrlSourcePromise, isCurrentMermaidLoadRequest, isMermaidLoadFailure, nextMermaidLoadRequestId } from './toolOutputDialogMermaid';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { blobFromImageElement } from '../imageSave';
import { openImageSaveActions } from '../imageSaveActionsBus';
import { useResolvedImageResource } from '../imageSource';
import {
    IMAGE_VIEWER_MAX_SCALE,
    IMAGE_VIEWER_TAP_MOVE_THRESHOLD,
    clampImageViewerTransform,
    getFittedImageSize,
    panImageViewer,
    pinchImageViewer,
    resolveImageViewerPointerRelease,
    zoomImageViewerAtPoint,
    type ImageViewerGeometry,
    type ImageViewerPoint,
    type ImageViewerTransform,
} from './imageViewerTransform';
import { closeImageViewerAfterMobileTap } from './imageViewerTapGuard';
import { MediaPreviewOverlay, PreviewCloseButton } from './MediaPreviewOverlay';

const IMAGE_VIEWER_LONG_PRESS_MS = 500;
/** Ignore accidental close from the same gesture / history thrash that opened the viewer. */
const IMAGE_VIEWER_OPEN_CLOSE_GUARD_MS = 400;

interface ToolOutputDialogProps {
    popup: ToolPopupContent;
    onOpenChange: (open: boolean) => void;
    isMobile: boolean;
}

const mermaidLoadFailure = (key: I18nKey, params?: I18nParams): MermaidLoadFailure => new MermaidLoadFailure(key, params);

const getToolIcon = (toolName: string) => {
    const iconClass = 'h-3.5 w-3.5 flex-shrink-0';
    const tool = toolName.toLowerCase();

    if (tool === 'reasoning') {
        return <Icon name="brain-ai-3" className={iconClass} />;
    }
    if (tool === 'image-preview') {
        return <Icon name="file-image" className={iconClass} />;
    }
    if (tool === 'mermaid-preview') {
        return <Icon name="file-list-2" className={iconClass} />;
    }
    if (tool === 'edit' || tool === 'multiedit' || tool === 'apply_patch' || tool === 'str_replace' || tool === 'str_replace_based_edit_tool') {
        return <Icon name="pencil-ai" className={iconClass} />;
    }
    if (tool === 'write' || tool === 'create' || tool === 'file_write') {
        return <Icon name="file-pdf" className={iconClass} />;
    }
    if (tool === 'read' || tool === 'view' || tool === 'file_read' || tool === 'cat') {
        return <Icon name="file-pdf" className={iconClass} />;
    }
    if (tool === 'bash' || tool === 'shell' || tool === 'cmd' || tool === 'terminal') {
        return <Icon name="terminal-box" className={iconClass} />;
    }
    if (tool === 'list' || tool === 'ls' || tool === 'dir' || tool === 'list_files') {
        return <Icon name="folder-6" className={iconClass} />;
    }
    if (tool === 'search' || tool === 'grep' || tool === 'find' || tool === 'ripgrep') {
        return <Icon name="search" className={iconClass} />;
    }
    if (tool === 'glob') {
        return <Icon name="file-search" className={iconClass} />;
    }
    if (tool === 'fetch' || tool === 'curl' || tool === 'wget' || tool === 'webfetch') {
        return <Icon name="global" className={iconClass} />;
    }
    if (tool === 'web-search' || tool === 'websearch' || tool === 'search_web' || tool === 'google' || tool === 'bing' || tool === 'duckduckgo') {
        return <Icon name="search" className={iconClass} />;
    }
    if (tool === 'todowrite' || tool === 'todoread') {
        return <Icon name="list-check-3" className={iconClass} />;
    }
    if (tool.startsWith('git')) {
        return <Icon name="git-branch" className={iconClass} />;
    }
    return <Icon name="tools" className={iconClass} />;
};

const DIALOG_CODE_TAG_PROPS = { style: { background: 'transparent', backgroundColor: 'transparent', fontSize: 'inherit' } };

const MERMAID_CONTROLS = { download: false, copy: false, showPanZoomControls: true };

type PierreThemeConfig = {
    theme: { light: string; dark: string };
    themeType: 'light' | 'dark';
};

const TOOL_DIFF_UNSAFE_CSS = `
  [data-diff-header],
  [data-diff] {
    [data-separator] {
      height: 24px !important;
    }
  }
`;

const TOOL_DIFF_METRICS = {
    hunkLineCount: 50,
    lineHeight: 24,
    diffHeaderHeight: 44,
    hunkSeparatorHeight: 24,
    spacing: 0,
};

const usePierreThemeConfig = (): PierreThemeConfig => {
    const themeSystem = useOptionalThemeSystem();
    const fallbackLightTheme = React.useMemo(() => getDefaultTheme(false), []);
    const fallbackDarkTheme = React.useMemo(() => getDefaultTheme(true), []);

    const availableThemes = React.useMemo(
        () => themeSystem?.availableThemes ?? [fallbackLightTheme, fallbackDarkTheme],
        [fallbackDarkTheme, fallbackLightTheme, themeSystem?.availableThemes],
    );
    const lightThemeId = themeSystem?.lightThemeId ?? fallbackLightTheme.metadata.id;
    const darkThemeId = themeSystem?.darkThemeId ?? fallbackDarkTheme.metadata.id;

    const lightTheme = React.useMemo(
        () => availableThemes.find((theme) => theme.metadata.id === lightThemeId) ?? fallbackLightTheme,
        [availableThemes, fallbackLightTheme, lightThemeId],
    );
    const darkTheme = React.useMemo(
        () => availableThemes.find((theme) => theme.metadata.id === darkThemeId) ?? fallbackDarkTheme,
        [availableThemes, darkThemeId, fallbackDarkTheme],
    );

    React.useEffect(() => {
        ensurePierreThemeRegistered(lightTheme);
        ensurePierreThemeRegistered(darkTheme);
    }, [darkTheme, lightTheme]);

    const currentVariant = themeSystem?.currentTheme.metadata.variant ?? 'light';

    return {
        theme: { light: lightTheme.metadata.id, dark: darkTheme.metadata.id },
        themeType: currentVariant === 'dark' ? 'dark' : 'light',
    };
};

type ViewportSize = { width: number; height: number };

const getWindowViewport = (): ViewportSize => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 0,
    height: typeof window !== 'undefined' ? window.innerHeight : 0,
});

const usePreviewViewport = (open: boolean) => {
    const [viewport, setViewport] = React.useState<ViewportSize>(getWindowViewport);

    React.useEffect(() => {
        if (!open || typeof window === 'undefined') {
            return;
        }

        const onResize = () => {
            setViewport(getWindowViewport());
        };

        onResize();
        window.addEventListener('resize', onResize);
        return () => {
            window.removeEventListener('resize', onResize);
        };
    }, [open]);

    return viewport;
};

const ImagePreviewDialog: React.FC<{
    popup: ToolPopupContent;
    onOpenChange: (open: boolean) => void;
    isMobile: boolean;
}> = ({ popup, onOpenChange, isMobile }) => {
    const { t } = useI18n();
    const themeSystem = useOptionalThemeSystem();
    const effectiveDirectory = useEffectiveDirectory() ?? '';
    const gallery = React.useMemo(() => {
        const baseImage = popup.image;
        if (!baseImage) return [] as Array<{ url: string; mimeType?: string; filename?: string; size?: number }>;
        const fromPopup = Array.isArray(baseImage.gallery)
            ? baseImage.gallery.filter((item): item is { url: string; mimeType?: string; filename?: string; size?: number } => Boolean(item?.url))
            : [];

        if (fromPopup.length > 0) {
            return fromPopup;
        }

        return [{
            url: baseImage.url,
            mimeType: baseImage.mimeType,
            filename: baseImage.filename,
            size: baseImage.size,
        }];
    }, [popup.image]);

    const [currentIndex, setCurrentIndex] = React.useState(() => {
        const index = popup.image?.index ?? gallery.findIndex((item) => item.url === popup.image?.url);
        return index >= 0 && index < gallery.length ? index : 0;
    });
    const sourceElement = popup.previewSource instanceof HTMLImageElement ? popup.previewSource : undefined;
    const sourceSize = sourceElement?.naturalWidth && sourceElement.naturalHeight
        ? { width: sourceElement.naturalWidth, height: sourceElement.naturalHeight } : null;
    const [imageNaturalSize, setImageNaturalSize] = React.useState<{ width: number; height: number } | null>(sourceSize);
    const [imageLoaded, setImageLoaded] = React.useState(Boolean(sourceSize));
    const isRendered = popup.open;
    const viewport = usePreviewViewport(popup.open);
    const canvasRef = React.useRef<HTMLDivElement | null>(null);
    const viewerRef = React.useRef<HTMLDivElement | null>(null);
    const imageRef = React.useRef<HTMLImageElement | null>(null);
    const zoomLabelRef = React.useRef<HTMLSpanElement | null>(null);
    const transformRef = React.useRef<ImageViewerTransform>({ scale: 1, x: 0, y: 0 });
    const geometryRef = React.useRef<ImageViewerGeometry>({
        image: { width: 1, height: 1 },
        viewport: { width: 1, height: 1 },
        maxScale: IMAGE_VIEWER_MAX_SCALE,
    });
    const pointersRef = React.useRef(new Map<number, { point: ImageViewerPoint; pointerType: string }>());
    const singleGestureRef = React.useRef<{
        pointerId: number;
        pointerType: string;
        start: ImageViewerPoint;
        transform: ImageViewerTransform;
        moved: boolean;
        targetWasCanvas: boolean;
        suppressTap: boolean;
        longPressTimer: ReturnType<typeof setTimeout> | null;
        longPressTriggered: boolean;
    } | null>(null);
    const pinchGestureRef = React.useRef<{
        distance: number;
        midpoint: ImageViewerPoint;
        transform: ImageViewerTransform;
    } | null>(null);
    const pendingFrameRef = React.useRef<number | null>(null);
    const pendingTransformRef = React.useRef<{ transform: ImageViewerTransform; animate: boolean } | null>(null);

    const openedAtRef = React.useRef(0);
    React.useEffect(() => {
        if (!popup.open) return;
        openedAtRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
    }, [popup.open]);

    const isWithinOpenCloseGuard = useEvent(() => {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        return now - openedAtRef.current < IMAGE_VIEWER_OPEN_CLOSE_GUARD_MS;
    });


    const clearLongPressTimer = useEvent(() => {
        const gesture = singleGestureRef.current;
        if (!gesture?.longPressTimer) return;
        clearTimeout(gesture.longPressTimer);
        gesture.longPressTimer = null;
    });

    React.useEffect(() => {
        if (!popup.open || gallery.length === 0) {
            return;
        }

        const requestedIndex = typeof popup.image?.index === 'number' ? popup.image.index : -1;
        if (requestedIndex >= 0 && requestedIndex < gallery.length) {
            setCurrentIndex(requestedIndex);
            return;
        }

        const matchingIndex = popup.image?.url
            ? gallery.findIndex((item) => item.url === popup.image?.url)
            : -1;
        setCurrentIndex(matchingIndex >= 0 ? matchingIndex : 0);
    }, [gallery, popup.image?.index, popup.image?.url, popup.open]);

    const currentImage = gallery[currentIndex] ?? gallery[0] ?? popup.image;
    const imageResource = useResolvedImageResource(currentImage?.url ?? '', effectiveDirectory, 'preview');
    const displayImageSource = imageResource.source || (currentImage?.url === popup.image?.url ? sourceElement?.currentSrc : '') || '';
    const imageDisplayKey = `${imageResource.key}\n${displayImageSource}`;
    const [failedImageKey, setFailedImageKey] = React.useState('');
    const hasImageError = Boolean(imageResource.error || failedImageKey === imageDisplayKey);
    const handleImageError = useEvent(() => setFailedImageKey(imageDisplayKey));
    const imageAccessibleLabel = currentImage?.filename || popup.title;
    const hasMultipleImages = gallery.length > 1;

    const openCurrentImageActions = useEvent(() => {
        const sourceUrl = currentImage?.url ?? popup.image?.url ?? '';
        if (!sourceUrl && !displayImageSource) return;
        const mimeType = currentImage?.mimeType || popup.image?.mimeType;
        const filename = currentImage?.filename || popup.image?.filename || popup.title;
        // Prefer bytes already decoded into the fullscreen <img> so save never
        // re-hits the runtime file path when the preview is on screen.
        const imageEl = imageRef.current;
        if (imageEl && imageEl.naturalWidth > 0) {
            void blobFromImageElement(imageEl, mimeType || 'image/png').then((prefetchedBlob) => {
                openImageSaveActions({
                    sourceUrl: sourceUrl || displayImageSource,
                    displayUrl: displayImageSource || imageEl.currentSrc || imageEl.src || undefined,
                    filename,
                    mimeType,
                    effectiveDirectory,
                    prefetchedBlob: prefetchedBlob ?? undefined,
                });
            });
            return;
        }
        openImageSaveActions({
            sourceUrl: sourceUrl || displayImageSource,
            displayUrl: displayImageSource || undefined,
            filename,
            mimeType,
            effectiveDirectory,
        });
    });

    const showPrevious = useEvent(() => {
        if (gallery.length <= 1) return;
        setCurrentIndex((prev) => (prev - 1 + gallery.length) % gallery.length);
    });

    const showNext = useEvent(() => {
        if (gallery.length <= 1) return;
        setCurrentIndex((prev) => (prev + 1) % gallery.length);
    });

    const imageDisplaySize = React.useMemo(() => {
        const viewingArea = {
            width: Math.max(1, viewport.width * (isMobile ? 1 : 0.8)),
            height: Math.max(1, viewport.height * (isMobile ? 1 : 0.95)),
        };
        return imageNaturalSize
            ? getFittedImageSize(imageNaturalSize, viewingArea)
            : viewingArea;
    }, [imageNaturalSize, isMobile, viewport.height, viewport.width]);

    const geometry = React.useMemo<ImageViewerGeometry>(() => ({
        image: imageDisplaySize,
        viewport: { width: Math.max(1, viewport.width), height: Math.max(1, viewport.height) },
        maxScale: IMAGE_VIEWER_MAX_SCALE,
    }), [imageDisplaySize, viewport.height, viewport.width]);

    const writeTransform = useEvent((next: ImageViewerTransform, animate = false) => {
        const transform = clampImageViewerTransform(next, geometryRef.current);
        transformRef.current = transform;
        pendingTransformRef.current = { transform, animate };
        if (pendingFrameRef.current !== null || typeof window === 'undefined') {
            return;
        }

        pendingFrameRef.current = window.requestAnimationFrame(() => {
            pendingFrameRef.current = null;
            const pending = pendingTransformRef.current;
            pendingTransformRef.current = null;
            if (!pending) return;

            if (imageRef.current) {
                imageRef.current.style.transition = pending.animate
                    ? 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)'
                    : 'none';
                imageRef.current.style.transform = `translate3d(${pending.transform.x}px, ${pending.transform.y}px, 0) scale(${pending.transform.scale})`;
            }
            if (zoomLabelRef.current) {
                zoomLabelRef.current.textContent = `${Math.round(pending.transform.scale * 100)}%`;
            }
            if (canvasRef.current) {
                canvasRef.current.style.cursor = pending.transform.scale > 1 ? 'grab' : 'zoom-in';
            }
        });
    });

    const resetTransform = useEvent((animate = true) => {
        writeTransform({ scale: 1, x: 0, y: 0 }, animate);
    });

    const viewportCenter = useEvent((): ImageViewerPoint => ({
        x: geometryRef.current.viewport.width / 2,
        y: geometryRef.current.viewport.height / 2,
    }));

    const zoomAtPoint = useEvent((nextScale: number, point: ImageViewerPoint, animate = false) => {
        writeTransform(zoomImageViewerAtPoint(
            transformRef.current,
            nextScale,
            point,
            viewportCenter(),
            geometryRef.current,
        ), animate);
    });

    const toggleZoom = useEvent((point: ImageViewerPoint) => {
        if (transformRef.current.scale > 1.01) {
            resetTransform(true);
            return;
        }
        zoomAtPoint(2, point, true);
    });

    const handleKeyDown = useEvent((event: KeyboardEvent) => {
        if (isMobile || event.defaultPrevented) return;

        if (event.key === '+' || event.key === '=') {
            event.preventDefault();
            zoomAtPoint(transformRef.current.scale * 1.4, viewportCenter(), true);
            return;
        }

        if (event.key === '-' || event.key === '_') {
            event.preventDefault();
            zoomAtPoint(transformRef.current.scale / 1.4, viewportCenter(), true);
            return;
        }

        if (event.key === '0') {
            event.preventDefault();
            resetTransform(true);
            return;
        }

        if (event.key === 'ArrowLeft' && hasMultipleImages) {
            event.preventDefault();
            showPrevious();
            return;
        }

        if (event.key === 'ArrowRight' && hasMultipleImages) {
            event.preventDefault();
            showNext();
        }
    });

    React.useEffect(() => {
        if (!popup.open) {
            return;
        }

        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- popup.open controls the subscription lifecycle; useEvent supplies the latest callback.
    }, [popup.open]);


    React.useEffect(() => {
        if (pendingFrameRef.current !== null) {
            window.cancelAnimationFrame(pendingFrameRef.current);
        }
        pendingFrameRef.current = null;
        pendingTransformRef.current = null;
        const source = currentImage?.url === popup.image?.url ? sourceElement : undefined;
        setImageNaturalSize(source?.naturalWidth && source.naturalHeight
            ? { width: source.naturalWidth, height: source.naturalHeight } : null);
        setImageLoaded(Boolean(source?.naturalWidth));
        transformRef.current = { scale: 1, x: 0, y: 0 };
        pointersRef.current.clear();
        singleGestureRef.current = null;
        pinchGestureRef.current = null;
        if (imageRef.current) {
            imageRef.current.style.transform = 'translate3d(0, 0, 0) scale(1)';
        }
        if (zoomLabelRef.current) {
            zoomLabelRef.current.textContent = '100%';
        }
    }, [currentImage?.url, displayImageSource, popup.image?.url, sourceElement]);

    React.useLayoutEffect(() => {
        geometryRef.current = geometry;
        const transform = clampImageViewerTransform(transformRef.current, geometryRef.current);
        transformRef.current = transform;
        if (imageRef.current) {
            imageRef.current.style.transition = 'none';
            imageRef.current.style.transform = `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`;
        }
    }, [geometry]);

    React.useEffect(() => () => {
        if (pendingFrameRef.current !== null) {
            window.cancelAnimationFrame(pendingFrameRef.current);
        }
        pendingFrameRef.current = null;
        pendingTransformRef.current = null;
        const gesture = singleGestureRef.current;
        if (gesture?.longPressTimer) {
            clearTimeout(gesture.longPressTimer);
            gesture.longPressTimer = null;
        }
    }, []);

    const handleWheel = useEvent((event: WheelEvent) => {
        if (isMobile) return;
        event.preventDefault();
        const point = { x: event.clientX, y: event.clientY };
        const factor = Math.exp(-event.deltaY * 0.002);
        zoomAtPoint(transformRef.current.scale * factor, point);
    });

    React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!isRendered || isMobile || !canvas) return;
        canvas.addEventListener('wheel', handleWheel, { passive: false });
        return () => canvas.removeEventListener('wheel', handleWheel);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- isRendered and isMobile control the subscription lifecycle; useEvent supplies the latest callback.
    }, [isMobile, isRendered]);

    const handleDoubleClick = useEvent((event: React.MouseEvent<HTMLDivElement>) => {
        if (isMobile) return;
        event.preventDefault();
        toggleZoom({ x: event.clientX, y: event.clientY });
    });

    const consumeViewerClick = useEvent((event: React.MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
    });

    const handlePointerDown = useEvent((event: React.PointerEvent<HTMLDivElement>) => {
        if (event.pointerType !== 'mouse') event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const point = { x: event.clientX, y: event.clientY };
        pointersRef.current.set(event.pointerId, { point, pointerType: event.pointerType });

        if (pointersRef.current.size === 1) {
            singleGestureRef.current = {
                pointerId: event.pointerId,
                pointerType: event.pointerType,
                start: point,
                transform: transformRef.current,
                moved: false,
                targetWasCanvas: event.target === event.currentTarget,
                suppressTap: false,
                longPressTimer: null,
                longPressTriggered: false,
            };
            // Long-press save: touch/pen always; mouse only when not dragging a zoomed image.
            if (event.pointerType !== 'mouse' || transformRef.current.scale <= 1.01) {
                const gesture = singleGestureRef.current;
                gesture.longPressTimer = setTimeout(() => {
                    if (!singleGestureRef.current || singleGestureRef.current.pointerId !== event.pointerId) return;
                    if (singleGestureRef.current.moved) return;
                    singleGestureRef.current.longPressTriggered = true;
                    singleGestureRef.current.suppressTap = true;
                    openCurrentImageActions();
                }, IMAGE_VIEWER_LONG_PRESS_MS);
            }
            if (canvasRef.current && transformRef.current.scale > 1) {
                canvasRef.current.style.cursor = 'grabbing';
            }
            return;
        }

        clearLongPressTimer();
        if (singleGestureRef.current) {
            singleGestureRef.current.suppressTap = true;
            singleGestureRef.current.longPressTriggered = false;
        }

        const points = Array.from(pointersRef.current.values()).slice(0, 2).map((pointer) => pointer.point);
        const dx = points[1].x - points[0].x;
        const dy = points[1].y - points[0].y;
        pinchGestureRef.current = {
            distance: Math.max(1, Math.hypot(dx, dy)),
            midpoint: { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 },
            transform: transformRef.current,
        };
        if (singleGestureRef.current) singleGestureRef.current.suppressTap = true;
    });

    const handlePointerMove = useEvent((event: React.PointerEvent<HTMLDivElement>) => {
        if (!pointersRef.current.has(event.pointerId)) return;
        event.preventDefault();
        const point = { x: event.clientX, y: event.clientY };
        pointersRef.current.set(event.pointerId, { point, pointerType: event.pointerType });

        if (pointersRef.current.size >= 2 && pinchGestureRef.current) {
            clearLongPressTimer();
            const points = Array.from(pointersRef.current.values()).slice(0, 2).map((pointer) => pointer.point);
            const dx = points[1].x - points[0].x;
            const dy = points[1].y - points[0].y;
            const midpoint = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
            const nextScale = pinchGestureRef.current.transform.scale
                * Math.hypot(dx, dy) / pinchGestureRef.current.distance;
            writeTransform(pinchImageViewer(
                pinchGestureRef.current.transform,
                pinchGestureRef.current.midpoint,
                midpoint,
                nextScale,
                viewportCenter(),
                geometryRef.current,
            ));
            return;
        }

        const gesture = singleGestureRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        const delta = { x: point.x - gesture.start.x, y: point.y - gesture.start.y };
        if (Math.hypot(delta.x, delta.y) > IMAGE_VIEWER_TAP_MOVE_THRESHOLD) {
            gesture.moved = true;
            clearLongPressTimer();
        }
        if (gesture.transform.scale > 1.01) {
            writeTransform(panImageViewer(gesture.transform, delta, geometryRef.current));
        }
    });

    const finishPointer = useEvent((event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
        const gesture = singleGestureRef.current;
        const trackedPointer = pointersRef.current.get(event.pointerId);
        const point = trackedPointer ? { x: event.clientX, y: event.clientY } : undefined;
        pointersRef.current.delete(event.pointerId);

        if (gesture?.pointerId === event.pointerId) {
            clearLongPressTimer();
            if (point && !gesture.longPressTriggered) {
                const action = resolveImageViewerPointerRelease({
                    isMobile,
                    pointerType: gesture.pointerType,
                    cancelled,
                    moved: gesture.moved || Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) > IMAGE_VIEWER_TAP_MOVE_THRESHOLD,
                    suppressTap: gesture.suppressTap,
                    targetWasCanvas: gesture.targetWasCanvas,
                    start: gesture.start,
                    end: point,
                    startScale: gesture.transform.scale,
                    hasMultipleImages,
                });
                if (action === 'next') showNext();
                if (action === 'previous') showPrevious();
                if (action === 'close') {
                    if (isWithinOpenCloseGuard()) return;
                    if (isMobile && gesture.pointerType !== 'mouse') {
                        closeImageViewerAfterMobileTap(point, () => onOpenChange(false));
                        return;
                    }
                    onOpenChange(false);
                }
            }
        }

        if (pointersRef.current.size === 1) {
            const [remainingId, remainingPointer] = Array.from(pointersRef.current.entries())[0];
            singleGestureRef.current = {
                pointerId: remainingId,
                pointerType: remainingPointer.pointerType,
                start: remainingPointer.point,
                transform: transformRef.current,
                moved: false,
                targetWasCanvas: false,
                suppressTap: true,
                longPressTimer: null,
                longPressTriggered: false,
            };
            pinchGestureRef.current = null;
        } else if (pointersRef.current.size === 0) {
            singleGestureRef.current = null;
            pinchGestureRef.current = null;
            if (canvasRef.current) {
                canvasRef.current.style.cursor = transformRef.current.scale > 1 ? 'grab' : 'zoom-in';
            }
        }

        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    });

    const handleContextMenu = useEvent((event: React.MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        openCurrentImageActions();
    });

    const handleImageLoad = useEvent((event: React.SyntheticEvent<HTMLImageElement>) => {
        const element = event.currentTarget;
        if (element.naturalWidth > 0 && element.naturalHeight > 0) {
            setImageNaturalSize((previous) => {
                if (previous?.width === element.naturalWidth && previous.height === element.naturalHeight) return previous;
                return { width: element.naturalWidth, height: element.naturalHeight };
            });
        }
        setImageLoaded(true);
    });

    if (!isRendered || !currentImage || typeof document === 'undefined') {
        return null;
    }

    const isDarkTheme = themeSystem?.currentTheme.metadata.variant === 'dark';
    const toolbarTone = isDarkTheme
        ? 'border-foreground/15 bg-foreground/10 text-foreground'
        : 'border-background/15 bg-background/10 text-background';
    const controlTone = isDarkTheme
        ? 'text-foreground hover:bg-foreground/15 hover:text-foreground'
        : 'text-background hover:bg-background/15 hover:text-background';

    const content = (
        <div
            ref={viewerRef}
            className="absolute inset-0 overflow-hidden select-none"
            tabIndex={-1}
            onClick={consumeViewerClick}
        >
            <PreviewCloseButton onClose={() => onOpenChange(false)} isMobile={isMobile} size={imageDisplaySize} />
            <div
                ref={canvasRef}
                className="absolute inset-0 flex items-center justify-center overflow-hidden touch-none [overscroll-behavior:none]"
                onDoubleClick={isMobile ? undefined : handleDoubleClick}
                onContextMenu={handleContextMenu}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={(event) => finishPointer(event, false)}
                onPointerCancel={(event) => finishPointer(event, true)}
                onLostPointerCapture={(event) => finishPointer(event, true)}
            >
                {!imageLoaded && !hasImageError && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center" role="status">
                        <span className="flex items-center gap-2 typography-ui-label opacity-70">
                            <Icon name="loader-4" className="size-4 animate-spin" />
                            {t('common.loading')}
                        </span>
                    </div>
                )}
                {hasImageError ? (
                    <p role="status" className="px-6 text-center typography-ui-label">
                        {t('filesView.error.readFileFailed')}
                    </p>
                ) : <img
                    ref={imageRef}
                    data-preview-transition-target=""
                    data-preview-return={currentImage?.url === popup.image?.url}
                    src={displayImageSource || undefined}
                    alt={imageAccessibleLabel ?? ''}
                    className={cn(
                        'block max-w-none object-contain will-change-transform',
                        imageLoaded ? 'opacity-100' : 'opacity-0',
                    )}
                    style={{ width: `${imageDisplaySize.width}px`, height: `${imageDisplaySize.height}px` }}
                    loading="lazy"
                    draggable={false}
                    onLoad={handleImageLoad}
                    onError={handleImageError}
                />}
            </div>

            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center px-2 pb-2">
                <div
                    className={cn('pointer-events-auto flex h-10 items-center gap-0.5 rounded-full border px-1 shadow-lg backdrop-blur-xl', toolbarTone)}
                    onPointerDown={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                >
                    {hasMultipleImages && (
                        <Button
                            variant="ghost"
                            size="icon"
                            className={cn('size-8 rounded-full', controlTone)}
                            onClick={showPrevious}
                            aria-label={t('chat.toolOutputDialog.image.previousAria')}
                            title={t('chat.toolOutputDialog.image.previousAria')}
                        >
                            <Icon name="arrow-left-s" className="size-5" />
                        </Button>
                    )}
                    {hasMultipleImages && (
                        <span className="min-w-10 px-1 text-center typography-micro tabular-nums opacity-80">
                            {currentIndex + 1} / {gallery.length}
                        </span>
                    )}
                    {hasMultipleImages && (
                        <Button
                            variant="ghost"
                            size="icon"
                            className={cn('size-8 rounded-full', controlTone)}
                            onClick={showNext}
                            aria-label={t('chat.toolOutputDialog.image.nextAria')}
                            title={t('chat.toolOutputDialog.image.nextAria')}
                        >
                            <Icon name="arrow-right-s" className="size-5" />
                        </Button>
                    )}
                    {hasMultipleImages && <span className="mx-0.5 h-4 w-px bg-current opacity-15" aria-hidden="true" />}
                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn('size-8 rounded-full', controlTone)}
                        onClick={() => zoomAtPoint(transformRef.current.scale / 1.4, viewportCenter(), true)}
                        aria-label={t('chat.toolOutputDialog.image.zoomOutAria')}
                        title={t('chat.toolOutputDialog.image.zoomOutAria')}
                    >
                        <Icon name="subtract" className="size-4" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        className={cn('h-8 min-w-14 rounded-full px-2 tabular-nums', controlTone)}
                        onClick={() => resetTransform(true)}
                        aria-label={t('chat.toolOutputDialog.image.resetZoomAria')}
                        title={t('chat.toolOutputDialog.image.resetZoomAria')}
                    >
                        <Icon name="restart" className="size-3.5" />
                        <span ref={zoomLabelRef}>100%</span>
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn('size-8 rounded-full', controlTone)}
                        onClick={() => zoomAtPoint(transformRef.current.scale * 1.4, viewportCenter(), true)}
                        aria-label={t('chat.toolOutputDialog.image.zoomInAria')}
                        title={t('chat.toolOutputDialog.image.zoomInAria')}
                    >
                        <Icon name="add" className="size-4" />
                    </Button>
                </div>
            </div>
        </div>
    );

    return content;
};

// ── PERF-007: Virtualised sub-components for dialog ──────────────────

const DialogUnifiedDiff: React.FC<{
    popup: ToolPopupContent;
    diffViewMode: DiffViewMode;
    pierreThemeConfig: PierreThemeConfig;
}> = React.memo(({ popup, diffViewMode, pierreThemeConfig }) => {
    const patchContent = popup.content || '';

    return (
        <div className="typography-code">
            <PatchDiff
                patch={patchContent}
                metrics={TOOL_DIFF_METRICS}
                options={{
                    diffStyle: diffViewMode === 'unified' ? 'unified' : 'split',
                    diffIndicators: 'none',
                    hunkSeparators: 'line-info-basic',
                    lineDiffType: 'none',
                    disableFileHeader: true,
                    maxLineDiffLength: 1000,
                    expansionLineCount: 20,
                    overflow: 'wrap',
                    theme: pierreThemeConfig.theme,
                    themeType: pierreThemeConfig.themeType,
                    unsafeCSS: TOOL_DIFF_UNSAFE_CSS,
                }}
                className="block w-full"
            />
        </div>
    );
});

DialogUnifiedDiff.displayName = 'DialogUnifiedDiff';

const DialogReadContent: React.FC<{
    popup: ToolPopupContent;
    pierreThemeConfig: PierreThemeConfig;
}> = React.memo(({ popup, pierreThemeConfig }) => {
    const parsedReadOutput = React.useMemo(() => parseReadToolOutput(popup.content), [popup.content]);

    const inputMeta = popup.metadata?.input;
    const inputObj = typeof inputMeta === 'object' && inputMeta !== null ? (inputMeta as Record<string, unknown>) : {};
    const offset = typeof inputObj.offset === 'number' ? inputObj.offset : 0;
    const filePath =
        typeof inputObj.file_path === 'string'
            ? inputObj.file_path
            : typeof inputObj.filePath === 'string'
                ? inputObj.filePath
                : typeof inputObj.path === 'string'
                    ? inputObj.path
                    : 'read-output';

    const fileContents = React.useMemo(() => parsedReadOutput.lines.map((line) => line.text).join('\n'), [parsedReadOutput]);
    const detectedLanguage = React.useMemo(
        () => popup.language || getLanguageFromExtension(filePath) || 'text',
        [filePath, popup.language],
    );

    const codeLines: CodeLine[] = React.useMemo(() => {
        const hasExplicitLineNumbers = parsedReadOutput.lines.some((line) => line.lineNumber !== null);
        const result: CodeLine[] = [];
        let nextLineNumber = offset;

        for (const line of parsedReadOutput.lines) {
            if (line.lineNumber !== null) {
                nextLineNumber = line.lineNumber;
            }
            const shouldAssignFallback =
                parsedReadOutput.type === 'file'
                && !hasExplicitLineNumbers
                && line.lineNumber === null
                && !line.isInfo;
            const effectiveLineNumber = line.lineNumber ?? (shouldAssignFallback
                ? (nextLineNumber + 1)
                : null);
            if (typeof effectiveLineNumber === 'number') {
                nextLineNumber = effectiveLineNumber;
            }

            result.push({
                text: line.text,
                lineNumber: effectiveLineNumber,
                isInfo: line.isInfo,
            });
        }

        return result;
    }, [offset, parsedReadOutput]);

    if (parsedReadOutput.type === 'file') {
        return (
            <PierreFile
                file={{
                    name: filePath,
                    contents: fileContents,
                    lang: detectedLanguage || undefined,
                }}
                options={{
                    disableFileHeader: true,
                    overflow: 'wrap',
                    theme: pierreThemeConfig.theme,
                    themeType: pierreThemeConfig.themeType,
                }}
                className="block w-full"
            />
        );
    }

    return (
        <VirtualizedCodeBlock
            lines={codeLines}
            language={detectedLanguage}
            maxHeight="70vh"
        />
    );
});

DialogReadContent.displayName = 'DialogReadContent';
const MermaidPreviewDialog: React.FC<{
    popup: ToolPopupContent;
    onOpenChange: (open: boolean) => void;
    isMobile: boolean;
}> = ({ popup, onOpenChange, isMobile }) => {
    const { t } = useI18n();
    const themeSystem = useOptionalThemeSystem();
    const previewTheme = React.useMemo(() => {
        if (themeSystem?.currentTheme.metadata.variant === 'dark') return themeSystem.currentTheme;
        return themeSystem?.availableThemes.find((theme) => theme.metadata.id === themeSystem.darkThemeId && theme.metadata.variant === 'dark')
            ?? getDefaultTheme(true);
    }, [themeSystem?.currentTheme, themeSystem?.availableThemes, themeSystem?.darkThemeId]);
    const [source, setSource] = React.useState<string>(popup.mermaid?.source || '');
    const [status, setStatus] = React.useState<'idle' | 'loading' | 'ready' | 'error'>(popup.mermaid?.source ? 'ready' : 'idle');
    const [errorMessage, setErrorMessage] = React.useState<string>('');
    const requestIdRef = React.useRef(0);

    const normalizeFilePath = React.useCallback((rawPath: string): string | null => {
        const input = rawPath.trim();
        if (!input.toLowerCase().startsWith('file://')) {
            return null;
        }

        const isSafeLocalPath = (path: string): boolean => {
            if (!path || /[\0\r\n]/.test(path)) {
                return false;
            }

            const normalized = path.replace(/\\/g, '/');
            const segments = normalized.split('/').filter(Boolean);
            if (segments.includes('..')) {
                return false;
            }

            if (normalized.startsWith('/')) {
                return true;
            }

            return /^[A-Za-z]:\//.test(normalized);
        };

        const decodeLoose = (value: string): string => {
            return value.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) => {
                const codePoint = Number.parseInt(hex, 16);
                return Number.isFinite(codePoint) ? String.fromCharCode(codePoint) : `%${hex}`;
            });
        };

        const canParse = typeof URL.canParse === 'function'
            ? URL.canParse(input)
            : false;

        if (canParse) {
            let pathname = decodeLoose(new URL(input).pathname || '');
            if (/^\/[A-Za-z]:\//.test(pathname)) {
                pathname = pathname.slice(1);
            }
            return isSafeLocalPath(pathname) ? pathname : null;
        }

        const stripped = input.replace(/^file:\/\//i, '');
        const decoded = decodeLoose(stripped);
        return isSafeLocalPath(decoded) ? decoded : (isSafeLocalPath(stripped) ? stripped : null);
    }, []);

    const loadMermaidSource = React.useCallback(async () => {
        const target = popup.mermaid;
        const requestId = nextMermaidLoadRequestId(requestIdRef.current);
        requestIdRef.current = requestId;

        if (!target?.url) {
            setStatus('error');
            setErrorMessage(t('chat.toolOutputDialog.mermaid.missingSource'));
            return;
        }

        if (target.source) {
            setSource(target.source);
            setStatus('ready');
            setErrorMessage('');
            return;
        }

        setStatus('loading');
        setErrorMessage('');

        let sourcePromise: Promise<string>;
        if (target.url.startsWith('data:')) {
            sourcePromise = getMermaidDataUrlSourcePromise(target.url);
        } else if (target.url.toLowerCase().startsWith('file://')) {
            const normalizedPath = normalizeFilePath(target.url);
            if (!normalizedPath) {
                sourcePromise = Promise.reject(mermaidLoadFailure('chat.toolOutputDialog.mermaid.invalidLocalPath'));
            } else {
                sourcePromise = runtimeFetch('/api/fs/raw', { query: { path: normalizedPath } })
                    .then((response) => {
                        if (!response.ok) {
                            return Promise.reject(mermaidLoadFailure('chat.toolOutputDialog.mermaid.readFileFailedWithStatus', { status: response.status }));
                        }
                        return response.text();
                    });
            }
        } else {
            const canParse = typeof URL.canParse === 'function'
                ? URL.canParse(target.url, window.location.origin)
                : false;
            const resolvedUrl = canParse ? new URL(target.url, window.location.origin) : null;

            if (!resolvedUrl || (resolvedUrl.protocol !== 'http:' && resolvedUrl.protocol !== 'https:')) {
                sourcePromise = Promise.reject(mermaidLoadFailure('chat.toolOutputDialog.mermaid.unsupportedUrlProtocol'));
            } else {
                sourcePromise = fetch(resolvedUrl.toString())
                    .then((response) => {
                        if (!response.ok) {
                            return Promise.reject(mermaidLoadFailure('chat.toolOutputDialog.mermaid.loadFailedWithStatus', { status: response.status }));
                        }
                        return response.text();
                    });
            }
        }

        await sourcePromise
            .then((resolvedSource) => {
                if (!isCurrentMermaidLoadRequest(requestIdRef.current, requestId)) {
                    return;
                }

                setSource(resolvedSource);
                setStatus('ready');
            })
            .catch((error) => {
                if (!isCurrentMermaidLoadRequest(requestIdRef.current, requestId)) {
                    return;
                }
                setStatus('error');
                setErrorMessage(isMermaidLoadFailure(error) ? t(error.key, error.params) : t('chat.toolOutputDialog.mermaid.loadFailed'));
            });
    }, [normalizeFilePath, popup.mermaid, t]);

    React.useEffect(() => {
        if (!popup.open || !popup.mermaid) {
            return;
        }
        void loadMermaidSource();
    }, [loadMermaidSource, popup.mermaid, popup.open]);

    const mermaidMarkdown = `\`\`\`mermaid\n${source}\n\`\`\``;

    if (!popup.open || typeof document === 'undefined') {
        return null;
    }

    const content = (
        <div className="absolute inset-0 flex items-center justify-center" onClick={(event) => {
            if (event.target === event.currentTarget) onOpenChange(false);
        }}>
                <div
                    data-mermaid-preview="true"
                    data-preview-transition-target=""
                    className="relative flex min-h-0 flex-col overflow-hidden"
                    style={{ width: isMobile ? '100%' : '80%', height: isMobile ? '100%' : '95%' }}
                    onMouseDown={(event) => event.stopPropagation()}
                >
                    <PreviewCloseButton onClose={() => onOpenChange(false)} isMobile={isMobile} />
                    <div
                        className="relative min-h-0 flex-1 overflow-hidden"
                    >
                        <div className="h-full overflow-hidden">
                            {status === 'loading' && (
                                <div className="h-full min-h-28 flex items-center justify-center gap-2 text-muted-foreground typography-meta">
                                    <Icon name="loader-4" className="h-4 w-4 animate-spin" />
                                    <span>{t('chat.toolOutputDialog.mermaid.loading')}</span>
                                </div>
                            )}

                            {status === 'error' && (
                                <div
                                    className="rounded-xl border p-3 space-y-3"
                                    style={{
                                        backgroundColor: 'var(--status-error-background)',
                                        borderColor: 'var(--status-error-border)',
                                    }}
                                >
                                    <p className="typography-markdown" style={{ color: 'var(--status-error)' }}>
                                        {errorMessage || t('chat.toolOutputDialog.mermaid.renderFailed')}
                                    </p>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            void loadMermaidSource();
                                        }}
                                        className="px-3 py-1.5 rounded-lg typography-meta border transition-colors hover:bg-[var(--interactive-hover)]"
                                        style={{
                                            borderColor: 'var(--interactive-border)',
                                            color: 'var(--surface-foreground)',
                                        }}
                                    >
                                        {t('chat.toolOutputDialog.mermaid.retry')}
                                    </button>
                                </div>
                            )}

                            {status === 'ready' && (
                                <div className="h-full">
                                    <SimpleMarkdownRenderer
                                        content={mermaidMarkdown}
                                        variant="tool"
                                        allowMermaidWheelEvents
                                        className="markdown-mermaid-fullscreen h-full"
                                         mermaidControls={MERMAID_CONTROLS}
                                         mermaidTheme={previewTheme}
                                        enableFileReferences={false}
                                    />
                                </div>
                            )}
                        </div>
                    </div>
                </div>
        </div>
    );

    return content;
};

const ToolOutputDialog: React.FC<ToolOutputDialogProps> = ({ popup, onOpenChange, isMobile }) => {
    const { t } = useI18n();
    const [diffViewMode, setDiffViewMode] = React.useState<DiffViewMode>('unified');
    const pierreThemeConfig = usePierreThemeConfig();

    React.useEffect(() => {
        if (!popup.open) return;
        setDiffViewMode('unified');
    }, [popup.open, popup.title]);

    if (popup.image || popup.mermaid) {
        return <MediaPreviewOverlay open={popup.open} title={popup.title} kind={popup.image ? 'image' : 'mermaid'}
            source={popup.previewSource} isMobile={isMobile} onOpenChange={onOpenChange}>
            {(close) => popup.image
                ? <ImagePreviewDialog popup={popup} onOpenChange={close} isMobile={isMobile} />
                : <MermaidPreviewDialog popup={popup} onOpenChange={close} isMobile={isMobile} />}
        </MediaPreviewOverlay>;
    }

    return (
        <Dialog open={popup.open} onOpenChange={onOpenChange}>
            <DialogContent
                className={cn(
                    'overflow-hidden flex flex-col min-h-0 pt-3 pb-4 px-4 gap-1',
                    '[&>button]:top-1.5',
                    isMobile ? 'w-[95vw] max-w-[95vw]' : 'max-w-5xl',
                    isMobile ? '[&>button]:right-1' : '[&>button]:top-2.5 [&>button]:right-4'
                )}
                style={{ maxHeight: '90vh' }}
            >
                <div className="flex-shrink-0 pb-1">
                    <div className="flex items-start gap-2 text-foreground typography-ui-header font-semibold">
                        {popup.metadata?.tool ? getToolIcon(popup.metadata.tool as string) : (
                            <Icon name="tools" className="h-3.5 w-3.5 text-foreground flex-shrink-0" />
                        )}
                        <span className="break-words flex-1 leading-tight">{popup.title}</span>
                        {popup.isDiff && (
                            <DiffViewToggle
                                mode={diffViewMode}
                                onModeChange={setDiffViewMode}
                                className="mr-8 flex-shrink-0"
                            />
                        )}
                    </div>
                </div>
                <div className="flex-1 min-h-0 rounded-xl border border-border/30 bg-muted/10 overflow-hidden">
                    <div className="tool-output-surface h-full max-h-[75vh] overflow-y-auto px-3 pr-4">
                        {popup.metadata?.input && typeof popup.metadata.input === 'object' &&
                            Object.keys(popup.metadata.input).length > 0 &&
                            popup.metadata?.tool !== 'todowrite' &&
                            popup.metadata?.tool !== 'todoread' &&
                            popup.metadata?.tool !== 'apply_patch' ? (() => {
                                const meta = popup.metadata!;
                                const input = meta.input as Record<string, unknown>;

                                const getInputValue = (key: string): string | null => {
                                  const val = input[key];
                                  return typeof val === 'string' ? val : (typeof val === 'number' ? String(val) : null);
                                };
                                return (
                                <div className="border-b border-border/20 p-4 -mx-3">
                                    <div className="typography-markdown font-medium text-muted-foreground mb-2 px-3">
                                        {meta.tool === 'bash' || meta.tool === 'shell'
                                            ? 'Command:'
                                            : meta.tool === 'task' || meta.tool === 'subagent'
                                                ? 'Task Details:'
                                                : 'Input:'}
                                    </div>
                                    {(meta.tool === 'bash' || meta.tool === 'shell') && getInputValue('command') ? (
                                        <div className="tool-input-surface bg-transparent rounded-xl border border-border/20 mx-3">
                                            <WorkerHighlightedCode
                                                language="bash"
                                                code={getInputValue('command')!}
                                                style={toolDisplayStyles.getPopupStyles()}
                                                codeStyle={DIALOG_CODE_TAG_PROPS.style}
                                                wrap
                                            />
                                        </div>
                                    ) : (meta.tool === 'task' || meta.tool === 'subagent') && getInputValue('prompt') ? (
                                        <div
                                            className="tool-input-surface bg-transparent rounded-xl border border-border/20 font-mono whitespace-pre-wrap text-foreground/90 mx-3"
                                            style={toolDisplayStyles.getPopupStyles()}
                                        >
                                            {getInputValue('description') ? `Task: ${getInputValue('description')}\n` : ''}
                                            {(getInputValue('subagent_type') || getInputValue('agent'))
                                                ? `Agent Type: ${getInputValue('subagent_type') || getInputValue('agent')}\n`
                                                : ''}
                                            {`Instructions:\n${getInputValue('prompt')}`}
                                        </div>
                                    ) : meta.tool === 'write' && getInputValue('content') ? (
                                        <div className="tool-input-surface bg-transparent rounded-xl border border-border/20 mx-3">
                                            <PierreFile
                                                file={{
                                                    name: getInputValue('filePath') || getInputValue('file_path') || 'new-file',
                                                    contents: getInputValue('content')!,
                                                    lang: getLanguageFromExtension(getInputValue('filePath') || getInputValue('file_path') || '') || undefined,
                                                }}
                                                options={{
                                                    disableFileHeader: true,
                                                    overflow: 'wrap',
                                                    theme: pierreThemeConfig.theme,
                                                    themeType: pierreThemeConfig.themeType,
                                                }}
                                                className="block w-full"
                                            />
                                        </div>
                                    ) : (
                                        <div
                                            className="tool-input-surface bg-transparent rounded-xl border border-border/20 font-mono whitespace-pre-wrap text-foreground/90 mx-3"
                                            style={toolDisplayStyles.getPopupStyles()}
                                        >
                                            {formatInputForDisplay(input, meta.tool as string)}
                                        </div>
                                    )}
                                </div>
                            );
                            })() : null}

                        {popup.isDiff ? (
                            <DialogUnifiedDiff
                                popup={popup}
                                diffViewMode={diffViewMode}
                                pierreThemeConfig={pierreThemeConfig}
                            />
                        ) : popup.content ? (
                        <div className="p-4">
                            {(() => {
                                const tool = popup.metadata?.tool;

                                if (tool === 'todowrite' || tool === 'todoread') {
                                    return (
                                        renderTodoOutput(popup.content) || (
                                            <WorkerHighlightedCode
                                                language="json"
                                                code={popup.content}
                                                style={toolDisplayStyles.getPopupContainerStyles()}
                                                codeStyle={DIALOG_CODE_TAG_PROPS.style}
                                                wrap
                                            />
                                        )
                                    );
                                }

                                if (tool === 'list') {
                                    return (
                                        renderListOutput(popup.content) || (
                                            <pre className="typography-markdown bg-muted/30 p-2 rounded-xl border border-border/20 font-mono whitespace-pre-wrap">
                                                {popup.content}
                                            </pre>
                                        )
                                );
                                }

                                if (tool === 'grep') {
                                    return (
                                        renderGrepOutput(popup.content, isMobile) || (
                                            <pre className="typography-code bg-muted/30 p-2 rounded-xl border border-border/20 font-mono whitespace-pre-wrap">
                                                {popup.content}
                                            </pre>
                                        )
                                    );
                                }

                                if (tool === 'glob') {
                                    return (
                                        renderGlobOutput(popup.content, isMobile) || (
                                            <pre className="typography-code bg-muted/30 p-2 rounded-xl border border-border/20 font-mono whitespace-pre-wrap">
                                                {popup.content}
                                            </pre>
                                        )
                                    );
                                }

                                if (tool === 'task' || tool === 'subagent' || tool === 'reasoning') {
                                    return (
                                        <div className={tool === 'reasoning' ? "text-muted-foreground/70" : ""}>
                                            <SimpleMarkdownRenderer content={popup.content} variant="tool" />
                                        </div>
                                    );
                                }

                                if (tool === 'web-search' || tool === 'websearch' || tool === 'search_web') {
                                    return (
                                        renderWebSearchOutput(popup.content) || (
                                            <WorkerHighlightedCode
                                                language="text"
                                                code={popup.content}
                                                style={toolDisplayStyles.getPopupContainerStyles()}
                                                codeStyle={DIALOG_CODE_TAG_PROPS.style}
                                                wrap
                                            />
                                        )
                                    );
                                }

                                if (tool === 'read') {
                                    return <DialogReadContent popup={popup} pierreThemeConfig={pierreThemeConfig} />;
                                }

                                // JSON tree viewer for generic JSON outputs
                                const jsonResult = popup.content ? tryParseJsonOutput(popup.content) : { data: null, isJson: false };
                                if (jsonResult.isJson) {
                                    return (
                                        <JsonTreeView
                                            jsonString={popup.content}
                                            initiallyExpandedDepth={3}
                                            maxHeight="70vh"
                                        />
                                    );
                                }

                                return (
                                    <WorkerHighlightedCode
                                        language={popup.language || 'text'}
                                        code={popup.content}
                                        style={toolDisplayStyles.getPopupContainerStyles()}
                                        codeStyle={DIALOG_CODE_TAG_PROPS.style}
                                        wrap
                                    />
                                );
                            })()}
                        </div>
                    ) : (
                        <div className="p-8 text-muted-foreground typography-ui-header">
                            <div className="mb-2">{t('chat.toolOutputDialog.commandCompleted')}</div>
                            <div className="typography-meta">{t('chat.toolOutputDialog.noOutputProduced')}</div>
                        </div>
                    )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
};

export default ToolOutputDialog;
