import React from 'react';
import { useDocumentVisibility, useEvent, useIntersectionObserver, useMediaQuery } from '@reactuses/core';
import { ASSISTANT_AVATAR_LICENSE, assistantAvatarStillScene, buildAssistantAvatarScene, createAssistantAvatarDefinition, resolveAssistantAvatar, type AvatarMotion } from '@/lib/assistant-avatar/recipe';
import { subscribeAvatarFrames } from '@/lib/assistant-avatar/frameClock';
import { sampleAnimation } from '@/lib/assistant-avatar/vendor/open-mascot/index.js';
import { generatedAvatarDataUri } from '@/lib/generatedAvatar';
import { cn } from '@/lib/utils';

type Props = { seed?: string; size: number; label?: string; className?: string; motion?: AvatarMotion };

// This leaf alone owns observers and per-frame DOM writes. Historical/static
// faces use the cached image path and allocate no animation Hooks or clock work.
function LiveFace({ seed, motion }: { seed?: string; motion: AvatarMotion }) {
  const group = React.useRef<SVGGElement>(null);
  const svg = React.useRef<SVGSVGElement>(null);
  const body = React.useRef<SVGPathElement>(null);
  const leftEye = React.useRef<SVGPathElement>(null);
  const rightEye = React.useRef<SVGPathElement>(null);
  const target = React.useRef({ x: 0, y: 0 });
  const [intersecting, setIntersecting] = React.useState(false);
  const visibility = useDocumentVisibility('visible');
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)', true);
  const definition = React.useMemo(() => createAssistantAvatarDefinition(seed), [seed]);
  const still = React.useMemo(() => assistantAvatarStillScene(seed), [seed]);
  useIntersectionObserver(svg, ([entry]) => setIntersecting(Boolean(entry?.isIntersecting)));
  const followPointer = useEvent((event: React.PointerEvent<SVGSVGElement>) => {
    if (event.pointerType !== 'mouse' || reducedMotion) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    target.current = {
      x: Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width - 0.5) * 2)),
      y: Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height - 0.5) * 2)),
    };
  });
  const resetPointer = useEvent(() => { target.current = { x: 0, y: 0 }; });

  React.useEffect(() => {
    const paint = (scene: ReturnType<typeof buildAssistantAvatarScene>) => {
      group.current?.setAttribute('transform', scene.transform);
      body.current?.setAttribute('d', scene.blob.path);
      leftEye.current?.setAttribute('d', scene.eyes[0].path);
      rightEye.current?.setAttribute('d', scene.eyes[1].path);
    };
    paint(still);
    if (!intersecting || visibility !== 'visible' || reducedMotion) return;
    const start = performance.now();
    const gaze = { x: 0, y: 0 };
    return subscribeAvatarFrames((timestamp) => {
      const pose = sampleAnimation(definition, motion, timestamp - start).pose;
      gaze.x += (target.current.x - gaze.x) * 0.2;
      gaze.y += (target.current.y - gaze.y) * 0.2;
      pose.gaze.x += gaze.x * 10;
      pose.gaze.y += gaze.y * 8;
      pose.blob.yaw += gaze.x * 10;
      paint(buildAssistantAvatarScene(definition, pose));
    });
  }, [definition, intersecting, motion, reducedMotion, still, visibility]);

  return (
    <svg ref={svg} viewBox="64 64 432 432" className="block h-full w-full" aria-hidden="true" data-avatar-motion={motion} data-avatar-active={intersecting && visibility === 'visible' && !reducedMotion ? 'true' : 'false'} onPointerMove={followPointer} onPointerLeave={resetPointer}>
      <metadata>{ASSISTANT_AVATAR_LICENSE}</metadata>
      <g ref={group} transform={still.transform}>
        <path ref={body} d={still.blob.path} fill={still.blob.fill} />
        <path ref={leftEye} d={still.eyes[0].path} fill={still.eyes[0].fill} />
        <path ref={rightEye} d={still.eyes[1].path} fill={still.eyes[1].fill} />
      </g>
    </svg>
  );
}

export const ProceduralAssistantAvatar = React.memo(function ProceduralAssistantAvatar({ seed, size, label, className, motion }: Props) {
  const box = `calc(${size}px * var(--dpt-n, 1))`;
  const recipe = React.useMemo(() => resolveAssistantAvatar(seed), [seed]);
  const image = React.useMemo(() => generatedAvatarDataUri('assistant', seed), [seed]);
  return (
    <span
      className={cn('inline-flex aspect-square shrink-0 overflow-clip rounded-[0.5rem]', className)}
      style={{ width: box, minWidth: box, maxWidth: box, height: box, minHeight: box, maxHeight: box }}
      data-agent-avatar=""
      data-avatar-kind="assistant"
      data-agent-avatar-shape="rounded"
      data-procedural-avatar=""
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {motion && recipe.animate
        ? <LiveFace seed={seed} motion={motion} />
        : <img src={image} alt="" draggable={false} className="block h-full w-full object-contain" aria-hidden="true" />}
    </span>
  );
});
