import './mediaPreviewTransition.css';

function animateImageCrop(source: HTMLElement, image: HTMLImageElement, viewer: HTMLDivElement,
    closing: boolean, complete: () => void): (() => void) | undefined {
    const thumbnail = source instanceof HTMLImageElement ? source : source.querySelector('img');
    if (!thumbnail || !image.complete || !image.naturalWidth || !image.animate) return;
    const full = image.getBoundingClientRect();
    const box = thumbnail.getBoundingClientRect();
    if (!full.width || !full.height || !box.width || !box.height) return;
    const style = getComputedStyle(thumbnail);
    const ratio = image.naturalWidth / image.naturalHeight;
    const cover = style.objectFit === 'cover';
    const width = cover ? Math.max(box.width, box.height * ratio) : Math.min(box.width, box.height * ratio);
    const height = width / ratio;
    const position = style.objectPosition.split(' ');
    // Computed percentage positions include the default centered crop.
    if (!position.every(value => value.endsWith('%'))) return;
    const x = (box.width - width) * parseFloat(position[0]) / 100;
    const y = (box.height - height) * parseFloat(position[1] ?? position[0]) / 100;
    let left = box.left;
    let top = box.top;
    let right = box.right;
    let bottom = box.bottom;
    let radius = style.borderRadius;
    for (let parent = thumbnail.parentElement; parent; parent = parent.parentElement) {
        const parentStyle = getComputedStyle(parent);
        const bounds = parent.getBoundingClientRect();
        if (['hidden', 'clip', 'auto', 'scroll'].includes(parentStyle.overflowX)) {
            left = Math.max(left, bounds.left); right = Math.min(right, bounds.right);
        }
        if (['hidden', 'clip', 'auto', 'scroll'].includes(parentStyle.overflowY)) {
            top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
        }
        if (bounds.width === box.width && bounds.height === box.height && parentStyle.borderRadius !== '0px') {
            radius = parentStyle.borderRadius;
        }
    }
    if (right <= left || bottom <= top) return;
    const frame = document.createElement('div');
    frame.dataset.mediaCropAnimation = '';
    frame.setAttribute('aria-hidden', 'true');
    Object.assign(frame.style, {
        position: 'fixed', left: '0', top: '0', overflow: 'hidden',
        pointerEvents: 'none', zIndex: '51', contain: 'paint',
    });
    const clone = document.createElement('img');
    clone.src = image.currentSrc || image.src;
    clone.alt = '';
    Object.assign(clone.style, {
        display: 'block', width: `${full.width}px`, height: `${full.height}px`,
        maxWidth: 'none', transformOrigin: '0 0',
    });
    frame.append(clone);
    document.body.append(frame);
    const fullFrame = { transform: `translate(${full.left}px, ${full.top}px)`, width: `${full.width}px`, height: `${full.height}px`, borderRadius: '0px' };
    const thumbFrame = { transform: `translate(${left}px, ${top}px)`, width: `${right - left}px`, height: `${bottom - top}px`, borderRadius: radius };
    const fullImage = { transform: 'translate(0px, 0px) scale(1)' };
    const thumbImage = { transform: `translate(${box.left + x - left}px, ${box.top + y - top}px) scale(${width / full.width})` };
    const options: KeyframeAnimationOptions = { duration: 280, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'both' };
    const visibility = image.style.visibility;
    image.style.visibility = 'hidden';
    const animations = [
        frame.animate(closing ? [fullFrame, thumbFrame] : [thumbFrame, fullFrame], options),
        clone.animate(closing ? [fullImage, thumbImage] : [thumbImage, fullImage], options),
        viewer.animate({ opacity: closing ? [1, 0] : [0, 1] }, options),
    ];
    let cancelled = false;
    const restore = (keepViewerFade = false) => {
        frame.remove();
        image.style.visibility = visibility;
        animations.forEach((animation, index) => {
            if (!keepViewerFade || index !== 2) animation.cancel();
        });
    };
    void Promise.all(animations.map(animation => animation.finished)).then(() => {
        if (cancelled) return;
        // React may commit the close later; keep the fullscreen viewer transparent until cleanup.
        restore(closing);
        complete();
    }, () => { if (!cancelled) { restore(); complete(); } });
    return () => { cancelled = true; restore(); };
}

/** Images use a clipped DOM layer; diagrams retain snapshots. The viewer owns its lifecycle. */
export function animateMediaPreview(
    source: HTMLElement | undefined,
    image: HTMLElement | null,
    viewer: HTMLDivElement | null,
    closing: boolean,
    complete: () => void = () => {},
): () => void {
    const rect = source?.getBoundingClientRect();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reducedMotion && source?.isConnected && image instanceof HTMLImageElement && viewer
        && rect?.width && rect.height && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth) {
        const cancel = animateImageCrop(source, image, viewer, closing, complete);
        if (cancel) return cancel;
    }
    if (!document.startViewTransition || reducedMotion
        || !source?.isConnected || !image || !viewer || !rect?.width || !rect.height
        || rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) {
        if (!viewer?.animate || reducedMotion) {
            complete();
            return () => {};
        }
        const animation = viewer.animate({ opacity: closing ? [1, 0] : [0, 1] }, { duration: 150, fill: 'forwards' });
        let cancelled = false;
        void animation.finished.then(() => { if (!cancelled) complete(); }, () => {});
        return () => { cancelled = true; animation.cancel(); };
    }

    const sourceName = source.style.viewTransitionName;
    const imageName = image.style.viewTransitionName;
    const visibility = viewer.style.visibility;
    let cancelled = false;
    const name = 'yuri-media-preview';
    source.style.viewTransitionName = closing ? 'none' : name;
    image.style.viewTransitionName = closing ? name : 'none';
    if (!closing) viewer.style.visibility = 'hidden';

    const transition = document.startViewTransition(() => {
        if (cancelled) return;
        source.style.viewTransitionName = closing ? name : 'none';
        image.style.viewTransitionName = closing ? 'none' : name;
        viewer.style.visibility = closing ? 'hidden' : visibility;
    });
    const restore = () => {
        source.style.viewTransitionName = sourceName;
        image.style.viewTransitionName = imageName;
        viewer.style.visibility = visibility;
    };
    void transition.ready.catch(() => {});
    const finish = () => {
        if (cancelled) return;
        restore();
        complete();
    };
    void transition.finished.then(finish, finish);
    return () => {
        cancelled = true;
        transition.skipTransition();
        restore();
    };
}
