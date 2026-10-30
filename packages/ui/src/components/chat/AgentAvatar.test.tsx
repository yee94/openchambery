import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, test, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentAvatar } from './AgentAvatar';
import { generatedAvatarDataUri } from '@/lib/generatedAvatar';

vi.mock('@/lib/generatedAvatar', async (original) => {
  const actual = await original<typeof import('@/lib/generatedAvatar')>();
  return { ...actual, generatedAvatarDataUri: vi.fn(actual.generatedAvatarDataUri) };
});

describe('AgentAvatar', () => {
  test('keeps ordinary faces rounded and allows square tiny badge faces', () => {
    const ordinary = renderToStaticMarkup(<AgentAvatar name="build" size={20} />);
    const badge = renderToStaticMarkup(<AgentAvatar name="build" size={10} shape="square" />);
    expect(ordinary).toContain('rounded-sm');
    expect(badge).toContain('rounded-none');
    expect(badge).not.toContain('rounded-sm');
  });
  test('assistant and agent faces render local image data with accessible labels', () => {
    const assistant = renderToStaticMarkup(<AgentAvatar kind="assistant" name="same-id" label="Assistant" />);
    const agent = renderToStaticMarkup(<AgentAvatar name="same-id" label="Agent" />);
    expect(assistant).toContain('src="data:image/svg+xml');
    expect(agent).toContain('src="data:image/svg+xml');
    expect(assistant).not.toBe(agent);
    expect(assistant).toContain('aria-label="Assistant"');
  });

  test('live assistants do not serialize an unused static SVG data URI', () => {
    vi.mocked(generatedAvatarDataUri).mockClear();
    renderToStaticMarkup(<AgentAvatar kind="assistant" name="live-only" motion="idle" />);
    expect(generatedAvatarDataUri).not.toHaveBeenCalled();
    renderToStaticMarkup(<AgentAvatar kind="assistant" name="history-only" />);
    expect(generatedAvatarDataUri).toHaveBeenCalledTimes(1);
  });

  test('50 unrelated parent updates perform no avatar generation; identity changes regenerate once', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    vi.mocked(generatedAvatarDataUri).mockClear();
    try {
      for (let i = 0; i < 50; i++) {
        await act(async () => root.render(<div data-draft={i}><AgentAvatar name="build" size={24} /></div>));
      }
      expect(generatedAvatarDataUri).toHaveBeenCalledTimes(1);
      await act(async () => root.render(<div data-draft={50}><AgentAvatar name="review" size={24} /></div>));
      expect(generatedAvatarDataUri).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
    }
  });

  test('renders an emoji at three quarters of the avatar size', () => {
    const markup = renderToStaticMarkup(<AgentAvatar name="assistant-1" emoji="🤖" size={24} label="Code Helper" />);

    expect(markup).toContain('font-size:calc(18px * var(--dpt-n, 1))');
    expect(markup).toContain('🤖');
    expect(markup).toContain('aria-label="Code Helper"');
    expect(markup).not.toContain('<svg');
  });

  test('locks every avatar to a square box', () => {
    const markup = renderToStaticMarkup(<AgentAvatar name="assistant-1" size={14} />);

    expect(markup).toContain('aspect-square');
    expect(markup).toContain('width:calc(14px * var(--dpt-n, 1))');
    expect(markup).toContain('min-width:calc(14px * var(--dpt-n, 1))');
    expect(markup).toContain('max-width:calc(14px * var(--dpt-n, 1))');
    expect(markup).toContain('height:calc(14px * var(--dpt-n, 1))');
    expect(markup).toContain('min-height:calc(14px * var(--dpt-n, 1))');
    expect(markup).toContain('max-height:calc(14px * var(--dpt-n, 1))');
  });
});
