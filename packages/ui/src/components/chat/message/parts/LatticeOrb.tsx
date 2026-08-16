import React from 'react';
import { cn } from '@/lib/utils';

const STAGE_SIZE = 28;
const GRID_SIZE = 3;
const GRID_OFFSET = 8;
const PITCH = 6;
const MID = 1;
const DOT_SIZE = 2.5;

export const LatticeOrb: React.FC<{
    size?: number;
    className?: string;
    label?: string;
}> = ({ size = 14, className, label = '' }) => {
    const cells = Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, index) => {
        const x = index % GRID_SIZE;
        const y = Math.floor(index / GRID_SIZE);
        const dx = x - MID;
        const dy = y - MID;
        const isCenter = dx === 0 && dy === 0;
        const delay = Math.hypot(dx, dy) * 700 - (isCenter ? 180 : 0);

        return { x, y, isCenter, delay };
    });

    return (
        <span
            className={cn('relative inline-block flex-none', className)}
            style={{ width: size, height: size }}
            role={label ? 'img' : undefined}
            aria-label={label || undefined}
            aria-hidden={label ? undefined : true}
        >
            <span
                className="pointer-events-none absolute left-0 top-0 block"
                style={{
                    width: STAGE_SIZE,
                    height: STAGE_SIZE,
                    transform: `scale(${size / STAGE_SIZE})`,
                    transformOrigin: 'top left',
                }}
            >
                {cells.map(({ x, y, isCenter, delay }) => (
                    <span
                        key={`${x}-${y}`}
                        className="oc-lattice-orb-dot absolute block rounded-full bg-current"
                        data-center={isCenter ? 'true' : undefined}
                        style={{
                            left: GRID_OFFSET + x * PITCH,
                            top: GRID_OFFSET + y * PITCH,
                            width: DOT_SIZE,
                            height: DOT_SIZE,
                            transform: 'translate(-50%, -50%)',
                            animationDelay: `${delay}ms`,
                        }}
                    />
                ))}
            </span>
        </span>
    );
};
