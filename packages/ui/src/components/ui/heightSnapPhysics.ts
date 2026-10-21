export type HeightSample = { height: number; time: number };
const VELOCITY_WINDOW_MS = 100;
const FLICK_VELOCITY = 0.35;
export const HEIGHT_SNAP_OVERSHOOT = 48;

export function sampleHeight(samples: HeightSample[], height: number, time: number): void {
  const last = samples.at(-1);
  const previous = samples.at(-2);
  if (last && previous && Math.abs(height - last.height) > 2
    && (height - last.height) * (last.height - previous.height) < 0) samples.splice(0, samples.length - 1);
  samples.push({ height, time });
  while (samples.length > 2 && (samples.length > 16 || samples[1].time < time - VELOCITY_WINDOW_MS)) samples.shift();
}

export function releaseHeightVelocity(samples: readonly HeightSample[], time: number): number {
  const last = samples.at(-1);
  if (!last || time - last.time >= VELOCITY_WINDOW_MS) return 0;
  const first = samples.find((sample) => sample.time >= time - VELOCITY_WINDOW_MS);
  if (!first || last.time <= first.time) return 0;
  // Include the pause between the final movement and release, not the whole gesture.
  return Math.max(-4, Math.min(4, (last.height - first.height) / Math.max(1, time - first.time)));
}

export function resolveHeightSnap<T>(points: readonly { id: T; height: number }[], startPoint: T, height: number, velocity: number, travel: number): T {
  const flick = Math.abs(velocity) >= FLICK_VELOCITY && Math.abs(travel) >= 8;
  const projected = height + (flick ? velocity * 180 : 0);
  const nearest = points.reduce((best, candidate) =>
    Math.abs(candidate.height - projected) < Math.abs(best.height - projected) ? candidate : best);
  const origin = points.find((point) => point.id === startPoint) ?? nearest;
  if (!flick || Math.abs(nearest.height - origin.height) > 1) return nearest.id;
  const adjacent = [...points].sort((a, b) => velocity > 0 ? a.height - b.height : b.height - a.height)
    .find((point) => velocity > 0 ? point.height > origin.height + 1 : point.height < origin.height - 1);
  return adjacent?.id ?? nearest.id;
}

export function resistHeight(height: number, minimum: number, maximum: number): number {
  const bound = height < minimum ? minimum : height > maximum ? maximum : height;
  const distance = height - bound;
  return bound + Math.sign(distance) * HEIGHT_SNAP_OVERSHOOT * (1 - 1 / (1 + Math.abs(distance) * 0.55 / HEIGHT_SNAP_OVERSHOOT));
}
