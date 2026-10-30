import { describe, expect, test, vi } from 'vitest';
import { Avatar } from '@dicebear/core';
import { generatedAvatarDataUri, type AvatarColorSet } from './generatedAvatar';

const svg = (uri: string) => decodeURIComponent(uri.slice(uri.indexOf(',') + 1));

describe('local generated avatars', () => {
  test('reuses artwork across rows; only the live DOM adapter animates Assistant faces', () => {
    const generate = vi.spyOn(Avatar.prototype, 'toDataUri');
    try {
      const colors = { background: '#22c55e' };
      const first = generatedAvatarDataUri('agent', 'shared-row-face', false, colors);
      for (let index = 0; index < 50; index += 1) {
        expect(generatedAvatarDataUri('agent', ' SHARED-ROW-FACE ', true, { ...colors })).toBe(first);
      }
      expect(generate).toHaveBeenCalledTimes(1);
      expect(generatedAvatarDataUri('agent', 'shared-row-face', false, { background: '#a855f7' })).not.toBe(first);
      expect(generate).toHaveBeenCalledTimes(2);
      const still = generatedAvatarDataUri('assistant', 'shared-row-face');
      expect(generatedAvatarDataUri('assistant', 'shared-row-face', true)).toBe(still);
      expect(generate).toHaveBeenCalledTimes(2);
      expect(generatedAvatarDataUri('agent', 'shared-row-face', false, colors)).toBe(first);
      expect(generate).toHaveBeenCalledTimes(2);
    } finally {
      generate.mockRestore();
    }
  });

  test('bounds retained artwork by entry count and bytes', () => {
    const generate = vi.spyOn(Avatar.prototype, 'toDataUri').mockReturnValue('data:image/svg+xml,small');
    try {
      generatedAvatarDataUri('agent', 'evicted-face');
      for (let index = 0; index < 128; index += 1) generatedAvatarDataUri('agent', `bounded-face-${index}`);
      generate.mockClear();
      generatedAvatarDataUri('agent', 'evicted-face');
      expect(generate).toHaveBeenCalledTimes(1);
      generate.mockReturnValue(`data:image/svg+xml,${'x'.repeat(1024 * 1024)}`);
      generatedAvatarDataUri('agent', 'oversize-face');
      generatedAvatarDataUri('agent', 'oversize-face');
      expect(generate).toHaveBeenCalledTimes(3);
    } finally {
      generate.mockRestore();
    }
  });

  test('exported SVGs are always static, including native thumbnail requests', () => {
    const active = svg(generatedAvatarDataUri('assistant', 'identity', true));
    expect(active).not.toContain('@keyframes');
    expect(active).toBe(svg(generatedAvatarDataUri('assistant', 'identity', false)));
    expect(svg(generatedAvatarDataUri('assistant', 'identity', false))).not.toContain('@keyframes');
    const agentActive = svg(generatedAvatarDataUri('agent', 'identity', true));
    const agentStill = svg(generatedAvatarDataUri('agent', 'identity', false));
    expect(agentActive).toBe(agentStill);
    expect(agentStill).not.toContain('@keyframes');
  });
  test.each(['assistant', 'agent'] as const)('%s is deterministic and different identities have different faces', (kind) => {
    const first = generatedAvatarDataUri(kind, 'identity-a');
    expect(first).toBe(generatedAvatarDataUri(kind, 'identity-a'));
    expect(first).not.toBe(generatedAvatarDataUri(kind, 'identity-b'));
    expect(first).toMatch(/^data:image\/svg\+xml/);
    expect(svg(first)).not.toMatch(/<script|<image|@keyframes|<animate/);
  });

  test('assistant and agent use distinct styles and agent retains source attribution', () => {
    const gaze = svg(generatedAvatarDataUri('assistant', 'identity'));
    const bot = svg(generatedAvatarDataUri('agent', 'identity'));
    expect(gaze).not.toBe(bot);
    expect(gaze).not.toContain('<metadata');
    expect(bot).toContain('Pablo Stanley');
    expect(bot).toContain('#c1f2c4');
    expect(generatedAvatarDataUri('agent', undefined)).toBe(generatedAvatarDataUri('agent', 'default'));
  });

  test('agent plate follows the provided badge palette', () => {
    const svgFor = (colors: AvatarColorSet) => svg(generatedAvatarDataUri('agent', 'build', false, colors));
    const green = svgFor({ background: '#22c55e' });
    const purple = svgFor({ background: '#a855f7' });
    expect(green).toContain('#22c55e');
    expect(purple).toContain('#a855f7');
    expect(green).not.toBe(purple);
    // Same identity and palette stays stable; identity alone still varies the face.
    expect(svgFor({ background: '#22c55e' })).toBe(green);
    expect(svg(generatedAvatarDataUri('agent', 'explore', false, { background: '#22c55e' }))).not.toBe(green);
  });
});
