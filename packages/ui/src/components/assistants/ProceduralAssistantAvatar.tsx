import React from 'react';
import { useDocumentVisibility, useEventListener, useIntersectionObserver, useMediaQuery } from '@reactuses/core';
import { resolveAssistantAvatar, type AvatarMotion, type AvatarEyeColor } from '@/lib/assistant-avatar/recipe';
import { mountAvatarAnimation } from '@/lib/assistant-avatar/runtime';
import { generatedAvatarDataUri } from '@/lib/generatedAvatar';
import { cn } from '@/lib/utils';

type Props = { seed?: string; size: number; label?: string; className?: string; motion?: AvatarMotion; hoverTarget?: React.RefObject<HTMLElement | null>; randomizeShape?: boolean; eyeColor?: AvatarEyeColor };

// This leaf owns observers and delegates DOM/frame work to the runtime. Historical/static
// faces use the cached image path and allocate no animation Hooks or clock work.
function LiveFace({ seed, motion, size, hoverTarget, randomizeShape = false, eyeColor }: { seed?: string; motion: AvatarMotion; size: number; hoverTarget?: React.RefObject<HTMLElement | null>; randomizeShape?: boolean; eyeColor?: AvatarEyeColor }) {
  const host = React.useRef<HTMLSpanElement>(null);
  const animation = React.useRef<ReturnType<typeof mountAvatarAnimation> | null>(null);
  const id = React.useId();
  const [intersecting, setIntersecting] = React.useState(false);
  const visibility = useDocumentVisibility('visible');
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)', true);
  const active = intersecting && visibility === 'visible' && !reducedMotion;
  useIntersectionObserver(host, ([entry]) => setIntersecting(Boolean(entry?.isIntersecting)));

  React.useLayoutEffect(() => {
    if (!host.current) return;
    const mounted = mountAvatarAnimation(host.current, { id: `avatar-${id.replace(/[^a-zA-Z0-9-]/g, '')}`, seed, randomizeShape, eyeColor });
    animation.current = mounted;
    return () => { mounted.dispose(); animation.current = null; };
  }, [id, seed, randomizeShape, eyeColor]);

  React.useEffect(() => {
    animation.current?.update({ active, motion, size });
  }, [active, motion, size, seed, randomizeShape, eyeColor]);

  useEventListener('pointerenter', (event: PointerEvent) => {
    if (event.pointerType === 'mouse') animation.current?.hover();
  }, () => active ? (hoverTarget ?? host).current : null);

  return (
    <span ref={host} className="block h-full w-full" aria-hidden="true" data-avatar-motion={motion} data-avatar-active={active ? 'true' : 'false'} />
  );
}

export const ProceduralAssistantAvatar = React.memo(function ProceduralAssistantAvatar({ seed, size, label, className, motion, hoverTarget, randomizeShape, eyeColor }: Props) {
  const box = `calc(${size}px * var(--dpt-n, 1))`;
  const recipe = React.useMemo(() => resolveAssistantAvatar(seed), [seed]);
  const live = Boolean(motion && recipe.animate);
  const image = React.useMemo(() => live ? undefined : generatedAvatarDataUri('assistant', seed, false, undefined, eyeColor), [live, seed, eyeColor]);
  return (
    <span
      className={cn('inline-flex aspect-square shrink-0 overflow-clip', className)}
      style={{ width: box, minWidth: box, maxWidth: box, height: box, minHeight: box, maxHeight: box }}
      data-agent-avatar=""
      data-avatar-kind="assistant"
      data-agent-avatar-shape="rounded"
      data-procedural-avatar=""
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {live && motion
        ? <LiveFace seed={seed} motion={motion} size={size} hoverTarget={hoverTarget} randomizeShape={randomizeShape} eyeColor={eyeColor} />
        : <img src={image} alt="" draggable={false} className="block h-full w-full object-contain" aria-hidden="true" />}
    </span>
  );
});
