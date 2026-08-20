import React from 'react';
import { cn } from '@/lib/utils';

const STAGE_SIZE = 28;
const MORPH_N = 8;
const MORPH_R = 10.5;
const QUARTER_TURN = Math.PI / 2;

const shapeCircleAt = (turn: number): ReadonlyArray<readonly [number, number]> => (
  Array.from({ length: MORPH_N }, (_, index) => {
    const angle = (index / MORPH_N) * Math.PI * 2 - Math.PI / 2 + turn;
    return [Math.cos(angle) * MORPH_R, Math.sin(angle) * MORPH_R] as const;
  })
);

const MORPH_SHAPES = [
  shapeCircleAt(0),
  shapeCircleAt(QUARTER_TURN),
  shapeCircleAt(Math.PI),
  shapeCircleAt(Math.PI * 1.5),
] as const;

const formatPoint = ([x, y]: readonly [number, number]): string => `${x.toFixed(1)}px, ${y.toFixed(1)}px`;

type MorphDotStyle = React.CSSProperties & {
  '--m-1': string;
  '--m-2': string;
  '--m-3': string;
  '--m-4': string;
};

type MorphGlyphStyle = React.CSSProperties & {
  '--orb-k': number;
};

export const MorphOrb: React.FC<{
  size?: number;
  isMobile?: boolean;
  className?: string;
}> = ({ size, isMobile = false, className }) => {
  const resolvedSize = size ?? (isMobile ? 12 : 14);

  return (
    <span
      className={cn('oc-morph-orb-glyph shrink-0', className)}
      style={{
        width: resolvedSize,
        height: resolvedSize,
        '--orb-k': resolvedSize / STAGE_SIZE,
      } as MorphGlyphStyle}
      aria-hidden="true"
    >
      <span className="oc-morph-orb-stage">
        {MORPH_SHAPES[0].map((_, index) => (
          <span
            key={index}
            className="oc-morph-orb-dot"
            style={{
              '--m-1': formatPoint(MORPH_SHAPES[0][index]),
              '--m-2': formatPoint(MORPH_SHAPES[1][index]),
              '--m-3': formatPoint(MORPH_SHAPES[2][index]),
              '--m-4': formatPoint(MORPH_SHAPES[3][index]),
            } as MorphDotStyle}
          />
        ))}
      </span>
    </span>
  );
};
