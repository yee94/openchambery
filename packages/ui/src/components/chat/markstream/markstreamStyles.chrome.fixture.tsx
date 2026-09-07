import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { MarkdownRenderer } from '../MarkdownRendererImpl';
import { MarkstreamRenderer } from '../MarkstreamRendererImpl';
import { I18nProvider } from '@/lib/i18n';
import { getDefaultTheme } from '@/lib/theme/themes';
import { CSSVariableGenerator } from '@/lib/theme/cssGenerator';
import { useUIStore } from '@/stores/useUIStore';
import { Icon } from '@/components/icon/Icon';
import { FixtureThemeContext } from './markstreamStyles.chrome.boundary.fixture';

const sourceA = ['```bash', 'curl --connect-timeout 5 \\', '  https://example.com/health \\', '  --write-out "status=%{http_code}"', '```'].join('\n');
const sourceB = ['```bash', 'printf "second sample\\n"', '```'].join('\n');
const root = createRoot(document.getElementById('root')!);
const generator = new CSSVariableGenerator();

const styleOf = (element: Element) => {
  const style = getComputedStyle(element);
  return Object.fromEntries([
    'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'border-top-style', 'border-bottom-style', 'border-radius', 'background-color',
    'padding', 'font-size', 'line-height', 'color',
  ].map((property) => [property, style.getPropertyValue(property)]));
};

const measure = (id: string) => {
  const host = document.getElementById(id)!;
  const card = host.querySelector('[data-component="markdown-code"]');
  if (!card || !card.firstElementChild) throw new Error(`Missing code card: ${id}`);
  const buttonStyle = (action: string) => {
    const style = styleOf(card.querySelector(`[data-md-action="${action}"]`)!);
    // Zero-width button borders have no painted edge. Compare the visible chrome.
    return Object.fromEntries(['color', 'background-color', 'border-radius', 'padding', 'font-size', 'line-height'].map((key) => [key, style[key]]));
  };
  return {
    card: styleOf(card),
    header: styleOf(card.firstElementChild),
    copy: buttonStyle('copy-code'),
    wrap: buttonStyle('toggle-code-wrap'),
    text: card.querySelector('pre code')?.textContent,
    libraryHeaderCount: host.querySelectorAll('.code-block-header, .code-block').length,
    codeId: host.querySelector('[data-oc-markstream-code-id]')?.getAttribute('data-oc-markstream-code-id'),
    width: card.getBoundingClientRect().width,
  };
};

const replay = async (dark: boolean, frame: 'A' | 'B' = 'A', sameIds = false) => {
  const theme = getDefaultTheme(dark);
  generator.apply(theme);
  document.documentElement.classList.add('mobile-pointer');
  useUIStore.setState({ isMobile: true, codeBlockLineWrap: true });
  // Settings typography is root-owned in the app. Keep the fixture's settings
  // stable across theme switches (the generator also emits defaults on .dark).
  document.getElementById('fixture-typography')?.remove();
  const typography = document.createElement('style');
  typography.id = 'fixture-typography';
  typography.textContent = ':root, .dark { --text-markdown: 15px !important; --text-code: 13px !important; }';
  document.head.appendChild(typography);
  const content = frame === 'A' ? sourceA : sourceB;
  const messageId = sameIds ? 'style-message-stable' : `style-message-${frame}`;
  const part = { id: sameIds ? 'style-part-stable' : `style-part-${frame}`, type: 'text' as const, text: content, messageID: messageId, sessionID: 'style-session' };
  const props = { content, messageId, part, isAnimated: false, skipFadeIn: true, enableFileReferences: false };
  flushSync(() => root.render(
    <FixtureThemeContext.Provider value={theme}>
      <I18nProvider>
        <main style={{ padding: 16 }}>
          <Icon name="file-copy" className="hidden" />
          <section id="legacy"><h2>Legacy</h2><MarkdownRenderer {...props} /></section>
          <section id="nested"><h2>Markstream</h2><MarkstreamRenderer {...props} /></section>
          <div id="global-probe" className="border border-border/80">Outside markdown</div>
        </main>
      </I18nProvider>
    </FixtureThemeContext.Provider>,
  ));
  // Wait for real async highlight + morph commits, with a bounded readiness gate.
  const expected = frame === 'A' ? 'https://example.com/health' : 'second sample';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (['legacy', 'nested'].every((id) => {
      const code = document.querySelector(`#${id} pre.shiki code`);
      return code?.textContent?.includes(expected);
    })) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { legacy: measure('legacy'), nested: measure('nested'), global: styleOf(document.getElementById('global-probe')!) };
};

const scrollReplay = async () => {
  flushSync(() => root.render(
    <I18nProvider>
      <div id="scroll-replay" style={{ height: 600, overflowY: 'auto', overflowAnchor: 'none', padding: '0 16px' }}>
        {Array.from({ length: 12 }, (_, index) => (
          <MarkstreamRenderer
            key={index}
            messageId={`scroll-${index}`}
            enableFileReferences={false}
            content={Array.from({ length: 3 + (index % 4) * 5 }, (_, paragraph) =>
              `Section ${index + 1}, paragraph ${paragraph + 1}: Scrolling must preserve settled content geometry.`,
            ).join('\n\n')}
          />
        ))}
      </div>
    </I18nProvider>,
  ));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const scroller = document.getElementById('scroll-replay')!;
  const initialHeight = scroller.scrollHeight;
  const heights: number[] = [];
  const visibility = Array.from(scroller.querySelectorAll('.markdown-renderer'), (element) =>
    getComputedStyle(element).contentVisibility,
  );
  // Cold forward travel then reverse travel must not substitute an estimate
  // for a settled message. Exercise the real renderer and imported CSS.
  for (const top of [150, 600, 1200, 2400, 3600, 4800, 3600, 2400, 1200, 600, 0]) {
    scroller.scrollTop = top;
    await new Promise((resolve) => setTimeout(resolve, 80));
    heights.push(scroller.scrollHeight);
  }
  return { initialHeight, heights, visibility };
};

Object.assign(window, { markstreamStyleReplay: replay, markstreamScrollReplay: scrollReplay });
