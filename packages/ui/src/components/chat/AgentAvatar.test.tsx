import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentAvatar } from './AgentAvatar';

describe('AgentAvatar', () => {
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
