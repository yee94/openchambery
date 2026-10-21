import { describe, expect, it } from 'vitest';
import { releaseHeightVelocity, resistHeight, resolveHeightSnap, sampleHeight } from './heightSnapPhysics';

const points = [{ id: 'auto', height: 140 }, { id: 'min', height: 52 }, { id: 'full', height: 720 }];

describe('height snap release intent', () => {
  it('advances on a short flick without requiring the midpoint, but preserves slow small adjustments', () => {
    expect(resolveHeightSnap(points, 'auto', 180, 0.6, 40)).toBe('full');
    expect(resolveHeightSnap(points, 'auto', 180, 0.08, 40)).toBe('auto');
    expect(resolveHeightSnap(points, 'full', 670, -0.6, -50)).toBe('auto');
    expect(resolveHeightSnap(points, 'full', 670, -0.08, -50)).toBe('full');
    expect(resolveHeightSnap(points, 'min', 92, 3.5, 40)).toBe('full');
    expect(resolveHeightSnap(points, 'auto', 142, 2, 2)).toBe('auto');
  });
  it('uses recent motion, forgets a held gesture and respects a reversal', () => {
    const samples = [{ height: 140, time: 0 }];
    sampleHeight(samples, 160, 20); sampleHeight(samples, 180, 40);
    expect(releaseHeightVelocity(samples, 45)).toBeCloseTo(40 / 45);
    expect(releaseHeightVelocity(samples, 160)).toBe(0);
    sampleHeight(samples, 164, 60);
    expect(releaseHeightVelocity(samples, 65)).toBeLessThan(0);
    sampleHeight(samples, 164, 180);
    expect(releaseHeightVelocity(samples, 180)).toBe(0);
  });
  it('keeps same-height semantic stops from creating an extra physical stop', () => {
    const tied = [{ id: 'auto', height: 52 }, { id: 'min', height: 52 }, { id: 'full', height: 720 }];
    expect(resolveHeightSnap(tied, 'auto', 52, 0, 0)).toBe('auto');
    expect(resolveHeightSnap(tied, 'min', 92, 0.5, 40)).toBe('full');
  });
});

it('tracks exactly within bounds and progressively resists overscroll', () => {
  expect(resistHeight(300, 100, 700)).toBe(300);
  expect(resistHeight(700, 100, 700)).toBe(700);
  expect(resistHeight(720, 100, 700)).toBeGreaterThan(700);
  expect(resistHeight(720, 100, 700)).toBeLessThan(720);
  expect(resistHeight(10000, 100, 700)).toBeLessThan(748);
  expect(resistHeight(-10000, 100, 700)).toBeGreaterThan(52);
});
