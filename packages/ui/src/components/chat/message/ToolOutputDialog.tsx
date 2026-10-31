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
import { readRuntimeFile } from '@/lib/runtime-file-resource';
import { MermaidLoadFailure, getMermaidDataUrlSourcePromise, isCurrentMermaidLoadRequest, isMermaidLoadFailure, nextMermaidLoadRequestId } from './toolOutputDialogMermaid';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { ImageViewerSlide, type ImageViewerSlideState } from './ImageViewerSlide';
import { animate as animateMotionValue, cancelFrame, frame, motionValue, type AnimationPlaybackControls, type MotionValue } from 'motion';
import {
    IMAGE_VIEWER_DISMISS_X_FOLLOW,
    IMAGE_VIEWER_DOUBLE_TAP_MS,
    IMAGE_VIEWER_DOUBLE_TAP_SCALE,
    IMAGE_VIEWER_MAX_SCALE,
    IMAGE_VIEWER_TAP_MOVE_THRESHOLD,
    IMAGE_VIEWER_VELOCITY_WINDOW_MS,
    clampImageViewerTransform,
    dragImageViewer,
    estimateImageViewerVelocity,
    getFittedImageSize,
    getImageViewerDismissStyle,
    isImageViewerDoubleTap,
    panImageViewer,
    pinchImageViewer,
    resolveImageViewerPointerRelease,
    resolveImageViewerDragRelease,
    zoomImageViewerAtPoint,
    type ImageViewerGeometry,
    type ImageViewerPoint,
    type ImageViewerPointerSample,
    type ImageViewerTransform,
    type ImageViewerDragAxis,
    type ImageViewerDragFrame,
} from './imageViewerTransform';
import { closeImageViewerAfterMobileTap } from './imageViewerTapGuard';
import { MediaPreviewOverlay, MediaPreviewToolbar, PreviewCloseButton } from './MediaPreviewOverlay';
import { VideoPreviewDialog } from './VideoPreviewDialog';
import { MediaSaveButton } from './MediaSaveButton';
import { isVideoSource } from '../video';

/** Ignore accidental close from the same gesture / history thrash that opened the viewer. */
const IMAGE_VIEWER_OPEN_CLOSE_GUARD_MS = 400;

type ImageViewerOffsets = { trackX: MotionValue<number>; dismissX: MotionValue<number>; dismissY: MotionValue<number> };

/** Skip identical writes so per-frame drag rendering only invalidates styles that changed. */
const writeStyle = (element: HTMLElement | null, property: 'transform' | 'opacity', value: string) => {
    if (element && element.style[property] !== value) element.style[property] = value;
};

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
    const activeDirectory = useEffectiveDirectory() ?? '';
    const effectiveDirectory = popup.image?.directory ?? activeDirectory;
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
    const [activeSlide, setActiveSlide] = React.useState<ImageViewerSlideState | null>(null);
    const imageNaturalSize = activeSlide?.naturalSize;
    const isRendered = popup.open;
    const viewport = usePreviewViewport(popup.open);
    const canvasRef = React.useRef<HTMLDivElement | null>(null);
    const viewerRef = React.useRef<HTMLDivElement | null>(null);
    const imageRef = React.useRef<HTMLImageElement | null>(null);
    const galleryTrackRef = React.useRef<HTMLDivElement | null>(null);
    const dismissRef = React.useRef<HTMLDivElement | null>(null);
    const controlsRef = React.useRef<HTMLDivElement | null>(null);
    const backdropRef = React.useRef<HTMLElement | null>(null);
    const [offsets] = React.useState<ImageViewerOffsets>(() => ({ trackX: motionValue(0), dismissX: motionValue(0), dismissY: motionValue(0) }));
    const settleRef = React.useRef<{ animations: AnimationPlaybackControls[] } | null>(null);
    const lastTapRef = React.useRef<ImageViewerPointerSample | null>(null);
    const tapCloseTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
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
        axis: ImageViewerDragAxis;
        samples: ImageViewerPointerSample[];
    } | null>(null);
    const pinchGestureRef = React.useRef<{
        distance: number;
        midpoint: ImageViewerPoint;
        transform: ImageViewerTransform;
    } | null>(null);
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
    const displayImageSource = activeSlide?.source ?? '';
    const imageResourceKey = activeSlide?.resourceKey ?? '';
    const hasMultipleImages = gallery.length > 1;
    const visibleIndices = isMobile && hasMultipleImages
        ? Array.from(new Set([(currentIndex - 1 + gallery.length) % gallery.length, currentIndex, (currentIndex + 1) % gallery.length]))
        : [currentIndex];

    const handleActiveImage = (state: ImageViewerSlideState) => {
        imageRef.current = state.element;
        setActiveSlide((previous) => previous?.element === state.element && previous.source === state.source
            && previous.resourceKey === state.resourceKey && previous.loaded === state.loaded && previous.error === state.error
            && previous.naturalSize?.width === state.naturalSize?.width && previous.naturalSize?.height === state.naturalSize?.height
            ? previous : state);
    };

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

    const renderViewer = useEvent(() => {
        const pending = pendingTransformRef.current;
        pendingTransformRef.current = null;
        if (pending) {
            if (imageRef.current) {
                imageRef.current.style.transition = pending.animate
                    ? 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)'
                    : 'none';
                imageRef.current.style.transform = `translate3d(${pending.transform.x}px, ${pending.transform.y}px, 0) scale(${pending.transform.scale})`;
            }
            if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${Math.round(pending.transform.scale * 100)}%`;
            if (canvasRef.current) canvasRef.current.style.cursor = pending.transform.scale > 1 ? 'grab' : 'zoom-in';
        }
        const trackX = offsets.trackX.get();
        const dismissY = offsets.dismissY.get();
        const dismiss = getImageViewerDismissStyle(dismissY, geometryRef.current.viewport.height);
        const track = galleryTrackRef.current;
        writeStyle(track, 'transform', `translate3d(${trackX}px, 0, 0)`);
        if (track && gallery.length === 2) {
            const neighbor = track.querySelector<HTMLElement>('[data-image-viewer-slide]:not([data-image-viewer-slide="0"])');
            writeStyle(neighbor, 'transform', `translate3d(${(trackX > 0 ? -1 : 1) * (viewport.width + 16)}px, 0, 0)`);
        }
        writeStyle(dismissRef.current, 'transform', `translate3d(${offsets.dismissX.get()}px, ${dismissY}px, 0) scale(${dismiss.scale})`);
        writeStyle(backdropRef.current, 'opacity', `${dismiss.opacity}`);
        writeStyle(controlsRef.current, 'opacity', `${dismiss.opacity}`);
    });

    // Motion batches pointer writes and spring updates into one render step per frame.
    const scheduleRender = useEvent(() => frame.render(renderViewer));

    const flushTransform = useEvent(() => {
        cancelFrame(renderViewer);
        renderViewer();
    });

    const writeTransform = useEvent((next: ImageViewerTransform, animate = false, drag: ImageViewerDragFrame | null = null) => {
        const transform = clampImageViewerTransform(next, geometryRef.current);
        transformRef.current = transform;
        pendingTransformRef.current = { transform, animate };
        offsets.trackX.jump(drag?.galleryX ?? 0);
        offsets.dismissX.jump(drag?.dismissX ?? 0);
        offsets.dismissY.jump(drag?.dismissY ?? 0);
        scheduleRender();
    });

    /** Stops an in-flight release at its current offsets so a new touch can take it over. */
    const cancelSettling = useEvent(() => {
        const settle = settleRef.current;
        settleRef.current = null;
        settle?.animations.forEach((animation) => animation.stop());
    });

    const clearPendingTapClose = useEvent(() => {
        if (tapCloseTimerRef.current !== null) clearTimeout(tapCloseTimerRef.current);
        tapCloseTimerRef.current = null;
    });

    const settleDrag = useEvent((action: 'none' | 'previous' | 'next', velocity: ImageViewerPoint = { x: 0, y: 0 }) => {
        cancelSettling();
        flushTransform();
        const targetX = action === 'next' ? -(viewport.width + 16) : action === 'previous' ? viewport.width + 16 : 0;
        const complete = () => {
            if (action === 'next') showNext();
            else if (action === 'previous') showPrevious();
            else {
                writeTransform(transformRef.current);
                flushTransform();
            }
        };
        const moving = ([
            [offsets.trackX, targetX, velocity.x],
            [offsets.dismissX, 0, velocity.x * IMAGE_VIEWER_DISMISS_X_FOLLOW],
            [offsets.dismissY, 0, velocity.y],
        ] as const).filter(([value, target]) => Math.abs(value.get() - target) > 0.5);
        if (moving.length === 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            complete();
            return;
        }
        const animations = moving.map(([value, target, speed]) => {
            // Carry finger momentum only toward the target; opposing velocity would overshoot.
            const towardTarget = speed * (target - value.get()) > 0 ? speed * 1000 : 0;
            return animateMotionValue(value, target, {
                type: 'spring',
                bounce: 0,
                visualDuration: action === 'none' ? 0.32 : 0.26,
                velocity: towardTarget,
                // Cut the imperceptible spring tail so a committed page change is not delayed by sub-pixel creep.
                restDelta: 1,
                restSpeed: 60,
                onUpdate: scheduleRender,
            });
        });
        const settle = { animations };
        settleRef.current = settle;
        void Promise.all(animations.map((animation) => animation.finished)).then(() => {
            if (settleRef.current !== settle) return;
            settleRef.current = null;
            if (!viewerRef.current?.closest('[data-media-preview-closing]')) complete();
        }, () => {
            if (settleRef.current !== settle) return;
            settleRef.current = null;
            writeTransform(transformRef.current);
            flushTransform();
        });
    });

    const resetTransform = useEvent((animate = true) => {
        cancelSettling();
        writeTransform({ scale: 1, x: 0, y: 0 }, animate);
    });

    const viewportCenter = useEvent((): ImageViewerPoint => ({
        x: geometryRef.current.viewport.width / 2,
        y: geometryRef.current.viewport.height / 2,
    }));

    const zoomAtPoint = useEvent((nextScale: number, point: ImageViewerPoint, animate = false) => {
        cancelSettling();
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
        zoomAtPoint(IMAGE_VIEWER_DOUBLE_TAP_SCALE, point, true);
    });

    /** A mobile tap waits out the double-tap window: a second nearby tap zooms at that point instead of closing. */
    const handleMobileTap = useEvent((tap: ImageViewerPointerSample) => {
        clearPendingTapClose();
        if (isImageViewerDoubleTap(lastTapRef.current, tap)) {
            lastTapRef.current = null;
            toggleZoom(tap);
            return;
        }
        lastTapRef.current = tap;
        if (isWithinOpenCloseGuard()) return;
        tapCloseTimerRef.current = setTimeout(() => {
            tapCloseTimerRef.current = null;
            lastTapRef.current = null;
            closeImageViewerAfterMobileTap(tap, () => onOpenChange(false));
        }, IMAGE_VIEWER_DOUBLE_TAP_MS);
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


    React.useLayoutEffect(() => {
        cancelFrame(renderViewer);
        pendingTransformRef.current = null;
        cancelSettling();
        clearPendingTapClose();
        lastTapRef.current = null;
        offsets.trackX.jump(0);
        offsets.dismissX.jump(0);
        offsets.dismissY.jump(0);
        transformRef.current = { scale: 1, x: 0, y: 0 };
        pointersRef.current.clear();
        singleGestureRef.current = null;
        pinchGestureRef.current = null;
        galleryTrackRef.current?.querySelectorAll('img').forEach((image) => {
            image.style.transition = 'none';
            image.style.transform = 'translate3d(0, 0, 0) scale(1)';
        });
        if (galleryTrackRef.current) galleryTrackRef.current.style.transform = 'translate3d(0, 0, 0)';
        if (dismissRef.current) dismissRef.current.style.transform = 'none';
        backdropRef.current = viewerRef.current?.closest('[data-media-preview]')?.querySelector<HTMLElement>('[data-media-preview-backdrop]') ?? null;
        if (backdropRef.current) backdropRef.current.style.opacity = '1';
        if (controlsRef.current) controlsRef.current.style.opacity = '1';
        if (zoomLabelRef.current) {
            zoomLabelRef.current.textContent = '100%';
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- the slide identity controls this reset; useEvent supplies the latest callbacks.
    }, [currentIndex, effectiveDirectory, popup.image?.url, offsets]);

    React.useLayoutEffect(() => {
        const resized = geometryRef.current.viewport.width !== geometry.viewport.width
            || geometryRef.current.viewport.height !== geometry.viewport.height;
        geometryRef.current = geometry;
        const transform = clampImageViewerTransform(transformRef.current, geometryRef.current);
        transformRef.current = transform;
        if (imageRef.current) {
            imageRef.current.style.transition = 'none';
            imageRef.current.style.transform = `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`;
        }
        if (resized) {
            cancelSettling();
            pointersRef.current.clear();
            singleGestureRef.current = null;
            pinchGestureRef.current = null;
            writeTransform(transform);
            flushTransform();
        }
    }, [geometry, cancelSettling, writeTransform, flushTransform]);

    React.useEffect(() => () => {
        cancelSettling();
        clearPendingTapClose();
        cancelFrame(renderViewer);
        pendingTransformRef.current = null;
        // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only cleanup; useEvent supplies the latest callbacks.
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

    React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!isRendered || !isMobile || !canvas) return;
        // Android Chromium hit-tests touch-action on the compositor, where transformed/zoomed layers can expose a
        // stale region and start a native pan that pointercancels the drag. A non-passive touchmove forces it to wait.
        const preventNativePan = (event: TouchEvent) => {
            if (event.cancelable) event.preventDefault();
        };
        canvas.addEventListener('touchmove', preventNativePan, { passive: false });
        return () => canvas.removeEventListener('touchmove', preventNativePan);
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
        const interrupted = settleRef.current !== null;
        cancelSettling();
        clearPendingTapClose();

        if (pointersRef.current.size === 1) {
            let start = point;
            let axis: ImageViewerDragAxis = null;
            const trackX = offsets.trackX.get();
            const dismissY = offsets.dismissY.get();
            const canCatch = interrupted && isMobile && event.pointerType !== 'mouse' && transformRef.current.scale <= 1.01;
            if (canCatch && Math.abs(trackX) > 0.5) {
                axis = 'x';
                start = { x: point.x - trackX, y: point.y };
            } else if (canCatch && dismissY > 0.5) {
                axis = 'y';
                start = { x: point.x - offsets.dismissX.get() / IMAGE_VIEWER_DISMISS_X_FOLLOW, y: point.y - dismissY };
            } else if (interrupted) {
                writeTransform(transformRef.current);
                flushTransform();
            }
            // A caught release continues from its current offset instead of jumping or being ignored.
            singleGestureRef.current = {
                pointerId: event.pointerId,
                pointerType: event.pointerType,
                start,
                transform: transformRef.current,
                moved: axis !== null,
                targetWasCanvas: event.target === event.currentTarget,
                suppressTap: false,
                axis,
                samples: [{ ...point, time: event.timeStamp }],
            };
            if (canvasRef.current && transformRef.current.scale > 1) {
                canvasRef.current.style.cursor = 'grabbing';
            }
            return;
        }

        if (singleGestureRef.current) {
            singleGestureRef.current.suppressTap = true;
        }
        writeTransform(transformRef.current);
        flushTransform();

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
        gesture.samples.push({ ...point, time: event.timeStamp });
        while (gesture.samples.length > 2 && event.timeStamp - gesture.samples[0].time > IMAGE_VIEWER_VELOCITY_WINDOW_MS) {
            gesture.samples.shift();
        }
        if (Math.hypot(delta.x, delta.y) > IMAGE_VIEWER_TAP_MOVE_THRESHOLD) {
            gesture.moved = true;
        }
        if (isMobile && gesture.pointerType !== 'mouse' && !gesture.suppressTap) {
            const frame = dragImageViewer(gesture.transform, delta, geometryRef.current, gesture.axis, hasMultipleImages);
            gesture.axis = frame.axis;
            writeTransform(frame.transform, false, frame);
        } else if (gesture.transform.scale > 1.01) {
            writeTransform(panImageViewer(gesture.transform, delta, geometryRef.current));
        }
    });

    const finishPointer = useEvent((event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
        const gesture = singleGestureRef.current;
        const trackedPointer = pointersRef.current.get(event.pointerId);
        if (!trackedPointer) return;
        const point = trackedPointer ? { x: event.clientX, y: event.clientY } : undefined;
        pointersRef.current.delete(event.pointerId);
        let closePoint: ImageViewerPoint | undefined;

        if (gesture?.pointerId === event.pointerId) {
            if (point) {
                const delta = { x: point.x - gesture.start.x, y: point.y - gesture.start.y };
                const moved = gesture.moved || Math.hypot(delta.x, delta.y) > IMAGE_VIEWER_TAP_MOVE_THRESHOLD;
                if (isMobile && gesture.pointerType !== 'mouse' && !gesture.suppressTap && moved) {
                    const frame = dragImageViewer(gesture.transform, delta, geometryRef.current, gesture.axis, hasMultipleImages);
                    writeTransform(frame.transform, false, frame);
                    const velocity = estimateImageViewerVelocity([...gesture.samples, { ...point, time: event.timeStamp }]);
                    const action = cancelled ? 'none' : resolveImageViewerDragRelease(frame, velocity, geometryRef.current.viewport);
                    if (action === 'close' && !isWithinOpenCloseGuard()) closePoint = point;
                    else settleDrag(action === 'close' ? 'none' : action, velocity);
                } else {
                    const action = resolveImageViewerPointerRelease({
                        isMobile,
                        pointerType: gesture.pointerType,
                        cancelled,
                        moved,
                        suppressTap: gesture.suppressTap,
                        targetWasCanvas: gesture.targetWasCanvas,
                        start: gesture.start,
                        end: point,
                        startScale: gesture.transform.scale,
                        hasMultipleImages,
                    });
                    if (action === 'next') showNext();
                    if (action === 'previous') showPrevious();
                    if (action === 'close' && isMobile && gesture.pointerType !== 'mouse') handleMobileTap({ ...point, time: event.timeStamp });
                    else if (action === 'close' && !isWithinOpenCloseGuard()) closePoint = point;
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
                axis: null,
                samples: [{ ...remainingPointer.point, time: event.timeStamp }],
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
        if (closePoint) {
            flushTransform();
            if (isMobile && gesture?.pointerType !== 'mouse') {
                closeImageViewerAfterMobileTap(closePoint, () => onOpenChange(false));
            } else onOpenChange(false);
        }
    });

    const handleContextMenu = useEvent((event: React.MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        if (singleGestureRef.current) {
            singleGestureRef.current.suppressTap = true;
        }
    });

    if (!isRendered || !currentImage || typeof document === 'undefined') {
        return null;
    }

    const isDarkTheme = themeSystem?.currentTheme.metadata.variant === 'dark';
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
            <div
                ref={canvasRef}
                data-image-viewer-canvas=""
                className="absolute inset-0 flex items-center justify-center overflow-hidden touch-none [overscroll-behavior:none]"
                onDoubleClick={isMobile ? undefined : handleDoubleClick}
                onContextMenu={handleContextMenu}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={(event) => finishPointer(event, false)}
                onPointerCancel={(event) => finishPointer(event, true)}
                onLostPointerCapture={(event) => finishPointer(event, true)}
            >
                <div ref={dismissRef} data-image-viewer-dismiss="" className="pointer-events-none absolute inset-0 will-change-transform">
                    <div ref={galleryTrackRef} data-image-viewer-track="" className="pointer-events-none absolute inset-0 will-change-transform">
                        {visibleIndices.map((index) => {
                            const item = gallery[index];
                            if (!item) return null;
                            const active = index === currentIndex;
                            const position = active ? 0 : gallery.length === 2 || index === (currentIndex + 1) % gallery.length ? 1 : -1;
                            return <ImageViewerSlide key={`${index}\n${item.url}`} url={item.url} directory={effectiveDirectory}
                                label={item.filename || popup.title} active={active} returnToSource={item.url === popup.image?.url}
                                sourceElement={item.url === popup.image?.url ? sourceElement : undefined}
                                viewport={viewport} isMobile={isMobile} position={position} onActiveImage={handleActiveImage} />;
                        })}
                    </div>
                </div>
            </div>

            <div ref={controlsRef} className="pointer-events-none absolute inset-0 [&_button]:pointer-events-auto">
                <PreviewCloseButton onClose={() => onOpenChange(false)} isMobile={isMobile} size={imageDisplaySize} />
                <MediaPreviewToolbar isMobile={isMobile}>
                    {hasMultipleImages && (
                        <span data-media-gallery-counter="" className="min-w-10 px-1 text-center typography-micro tabular-nums opacity-80">
                            {currentIndex + 1} / {gallery.length}
                        </span>
                    )}
                    {hasMultipleImages && <span className="mx-0.5 h-4 w-px bg-current opacity-15" aria-hidden="true" />}
                    <Button
                        variant={isMobile ? 'ghost' : 'mobileGlass'}
                        size={isMobile ? 'icon' : 'mobileIcon'}
                        className={cn('rounded-full', isMobile && 'size-8', isMobile && controlTone)}
                        onClick={() => zoomAtPoint(transformRef.current.scale / 1.4, viewportCenter(), true)}
                        aria-label={t('chat.toolOutputDialog.image.zoomOutAria')}
                        title={t('chat.toolOutputDialog.image.zoomOutAria')}
                    >
                        <Icon name="subtract" weight="medium" className={isMobile ? 'size-4' : 'size-6'} />
                    </Button>
                    <Button
                        variant={isMobile ? 'ghost' : 'mobileGlass'}
                        size={isMobile ? 'sm' : 'lg'}
                        data-media-zoom-reset=""
                        className={cn('rounded-full tabular-nums', isMobile ? 'min-w-12' : 'min-w-20', isMobile && controlTone)}
                        onClick={() => resetTransform(true)}
                        aria-label={t('chat.toolOutputDialog.image.resetZoomAria')}
                        title={t('chat.toolOutputDialog.image.resetZoomAria')}
                    >
                        <Icon name="restart" weight="medium" className={isMobile ? 'size-3.5' : 'size-5'} />
                        <span ref={zoomLabelRef}>100%</span>
                    </Button>
                    <Button
                        variant={isMobile ? 'ghost' : 'mobileGlass'}
                        size={isMobile ? 'icon' : 'mobileIcon'}
                        className={cn('rounded-full', isMobile && 'size-8', isMobile && controlTone)}
                        onClick={() => zoomAtPoint(transformRef.current.scale * 1.4, viewportCenter(), true)}
                        aria-label={t('chat.toolOutputDialog.image.zoomInAria')}
                        title={t('chat.toolOutputDialog.image.zoomInAria')}
                    >
                        <Icon name="add" weight="medium" className={isMobile ? 'size-4' : 'size-6'} />
                    </Button>
                    <MediaSaveButton isMobile={isMobile} key={imageResourceKey} target={{
                        sourceUrl: currentImage.url || displayImageSource, displayUrl: displayImageSource || undefined,
                        filename: currentImage.filename || popup.image?.filename || popup.title,
                        mimeType: currentImage.mimeType || popup.image?.mimeType, effectiveDirectory,
                    }} />
                </MediaPreviewToolbar>
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
                sourcePromise = readRuntimeFile({ path: normalizedPath })
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

    const video = popup.video ?? (popup.image && isVideoSource(popup.image.url, popup.image.mimeType) ? popup.image : undefined);
    if (popup.image || popup.mermaid || video) {
        return <MediaPreviewOverlay open={popup.open} title={popup.title} kind={video ? 'video' : popup.image ? 'image' : 'mermaid'}
            source={popup.previewSource} isMobile={isMobile} onOpenChange={onOpenChange}>
            {(close) => <>
                {video ? <VideoPreviewDialog video={video} onClose={close} isMobile={isMobile} /> : popup.image
                ? <ImagePreviewDialog popup={popup} onOpenChange={close} isMobile={isMobile} />
                : <MermaidPreviewDialog popup={popup} onOpenChange={close} isMobile={isMobile} />}
            </>}
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
