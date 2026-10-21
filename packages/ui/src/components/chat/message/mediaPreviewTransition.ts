import './mediaPreviewTransition.css';

/** Animate only the two image snapshots; the viewer owns its normal overlay lifecycle. */
export function animateMediaPreview(
    source: HTMLElement | undefined,
    image: HTMLElement | null,
    viewer: HTMLDivElement | null,
    closing: boolean,
    complete: () => void = () => {},
): () => void {
    const rect = source?.getBoundingClientRect();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
    const name = 'oc-media-preview';
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
