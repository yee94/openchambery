// Owns the imperative animation lifecycle for newly committed streaming Markdown blocks.

// Change this class to select the shared fade, blur, or reveal variant.
const STREAM_BLOCK_ANIMATION_CLASS = 'oc-stream-animate-fade';
const STREAM_BLOCK_STAGGER_MS = 45;
const STREAM_BLOCK_STAGGER_LIMIT = 3;

type ActiveStreamBlockAnimation = {
  targets: Set<HTMLElement>;
  handleAnimationEnd: (event: Event) => void;
};

const ACTIVE_STREAM_BLOCK_ANIMATIONS = new WeakMap<HTMLElement, ActiveStreamBlockAnimation>();

const cleanupAnimationTarget = (target: HTMLElement) => {
  target.classList.remove(STREAM_BLOCK_ANIMATION_CLASS);
  target.style.removeProperty('--oc-stream-delay');
};

const finishAnimationListener = (block: HTMLElement, active: ActiveStreamBlockAnimation) => {
  if (active.targets.size > 0) {
    return;
  }
  block.removeEventListener('animationend', active.handleAnimationEnd);
  ACTIVE_STREAM_BLOCK_ANIMATIONS.delete(block);
};

const reconcileAnimationTargets = (block: HTMLElement) => {
  const active = ACTIVE_STREAM_BLOCK_ANIMATIONS.get(block);
  if (!active) {
    return;
  }
  for (const target of active.targets) {
    if (!block.contains(target) || !target.classList.contains(STREAM_BLOCK_ANIMATION_CLASS)) {
      cleanupAnimationTarget(target);
      active.targets.delete(target);
    }
  }
  finishAnimationListener(block, active);
};

const getAnimationTargets = (block: HTMLElement): HTMLElement[] => (
  Array.from(block.children).filter((child): child is HTMLElement => {
    if (!(child instanceof HTMLElement)) {
      return false;
    }
    if (child.style.display === 'contents') {
      return false;
    }
    const view = child.ownerDocument.defaultView;
    return view?.getComputedStyle(child).display !== 'contents';
  })
);

export const animateNewStreamBlock = ({
  block,
  id,
  hadBlockId,
  seenIds,
  enabled,
  staggerIndex,
}: {
  block: HTMLElement;
  id: string;
  hadBlockId: boolean;
  seenIds: Set<string>;
  enabled: boolean;
  staggerIndex: number;
}): number => {
  reconcileAnimationTargets(block);
  const unseen = !seenIds.has(id);
  seenIds.add(id);
  if (!enabled || hadBlockId || !unseen) {
    return 0;
  }

  const targets = getAnimationTargets(block);
  if (targets.length === 0) {
    return 0;
  }

  targets.forEach((target, index) => {
    const delayIndex = Math.min(staggerIndex + index, STREAM_BLOCK_STAGGER_LIMIT - 1);
    target.style.setProperty('--oc-stream-delay', `${delayIndex * STREAM_BLOCK_STAGGER_MS}ms`);
    target.classList.add(STREAM_BLOCK_ANIMATION_CLASS);
  });

  let active: ActiveStreamBlockAnimation;
  const handleAnimationEnd = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !active.targets.has(target)) {
      return;
    }
    cleanupAnimationTarget(target);
    active.targets.delete(target);
    finishAnimationListener(block, active);
  };
  active = { targets: new Set(targets), handleAnimationEnd };
  ACTIVE_STREAM_BLOCK_ANIMATIONS.set(block, active);
  block.addEventListener('animationend', handleAnimationEnd);
  return targets.length;
};
