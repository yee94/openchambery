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
});
