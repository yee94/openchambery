import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentAvatar } from './AgentAvatar';

describe('AgentAvatar', () => {
  test('renders an emoji at three quarters of the avatar size', () => {
    const markup = renderToStaticMarkup(<AgentAvatar name="assistant-1" emoji="🤖" size={24} label="Code Helper" />);

    expect(markup).toContain('font-size:18px');
    expect(markup).toContain('🤖');
    expect(markup).toContain('aria-label="Code Helper"');
    expect(markup).not.toContain('<svg');
  });

  test('locks every avatar to a square box', () => {
    const markup = renderToStaticMarkup(<AgentAvatar name="assistant-1" size={14} />);

    expect(markup).toContain('aspect-square');
    expect(markup).toContain('width:14px');
    expect(markup).toContain('min-width:14px');
    expect(markup).toContain('max-width:14px');
    expect(markup).toContain('height:14px');
    expect(markup).toContain('min-height:14px');
    expect(markup).toContain('max-height:14px');
  });
});
