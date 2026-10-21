import { describe, expect, test } from 'vitest';
import { generatedAvatarDataUri, type AvatarColorSet } from './generatedAvatar';

const svg = (uri: string) => decodeURIComponent(uri.slice(uri.indexOf(',') + 1));

describe('local generated avatars', () => {
  test('Gaze animates only when requested, with reduced-motion support', () => {
    const active = svg(generatedAvatarDataUri('assistant', 'identity', true));
    expect(active).toContain('@keyframes');
    expect(active).toContain('prefers-reduced-motion: no-preference');
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

  test('assistant and agent use distinct styles and retain source attribution', () => {
    const gaze = svg(generatedAvatarDataUri('assistant', 'identity'));
    const bot = svg(generatedAvatarDataUri('agent', 'identity'));
    expect(gaze).not.toBe(bot);
    expect(gaze).toContain('Gaze');
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
