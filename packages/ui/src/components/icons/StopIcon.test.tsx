import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { SendCircleIcon, StopIcon } from './StopIcon';

const here = dirname(fileURLToPath(import.meta.url));
const chatInputSource = readFileSync(join(here, '../chat/ChatInput.tsx'), 'utf-8');
const chatPromptComposerSource = readFileSync(join(here, '../chat/ChatPromptComposer.tsx'), 'utf-8');
const mobileCss = readFileSync(join(here, '../../styles/mobile.css'), 'utf-8');

describe('StopIcon', () => {
  test('paints an inverted circle with a solid stop square', () => {
    const html = renderToString(<StopIcon className="size-6" />);

    expect(html).toContain('rounded-full');
    expect(html).toContain('bg-foreground');
    expect(html).toContain('text-background');
    expect(html).toContain('data-stop-glyph="true"');
    expect(html).toContain('rounded-[20%]');
    expect(html).toContain('bg-current');
    expect(html).not.toContain('rounded-[28%]');
    expect(html).not.toContain('#oc-time');
  });

  test('is decorative so the owning button keeps the accessible name', () => {
    const html = renderToString(<StopIcon />);

    expect(html).toContain('aria-hidden');
  });

  test('composer stop controls keep a circular hit target and a 24px mobile glyph', () => {
    expect(chatInputSource).toContain("stopIconSizeClass = isMobile ? 'h-6 w-6' : 'size-full'");
    expect(chatInputSource).toContain("'h-6 w-6'");
    expect(chatPromptComposerSource).toContain('data-composer-stop="true"');
    expect(chatPromptComposerSource).toContain('rounded-full outline-none hover:opacity-80');
    expect(chatPromptComposerSource).toContain("<StopIcon className={isMobile ? 'size-6' : 'size-full'} />");
  });
});

describe('SendCircleIcon', () => {
  test('paints an inverted circle with an up arrow', () => {
    const html = renderToString(<SendCircleIcon className="size-6" />);

    expect(html).toContain('rounded-full');
    expect(html).toContain('bg-foreground');
    expect(html).toContain('text-background');
    expect(html).toContain('#oc-arrow-up');
    expect(html).not.toContain('#oc-send-plane-2');
  });

  test('spins a loader while a send is in flight', () => {
    const html = renderToString(<SendCircleIcon spinning />);

    expect(html).toContain('#oc-loader-4');
    expect(html).toContain('animate-spin');
  });

  test('ready send uses the same filled-circle control as stop', () => {
    expect(chatInputSource).toContain('showSendCircle');
    expect(chatInputSource).toContain('<SendCircleIcon');
    expect(chatPromptComposerSource).toContain('<SendCircleIcon');
    expect(chatPromptComposerSource).toContain('data-composer-circle={sendReady ? \'true\' : undefined}');
  });
});

describe('compact composer concentric circle', () => {
  test('keeps the 24px expanded glyph concentric in the pill cap', () => {
    expect(mobileCss).toContain('inset: 0 0.625rem');
    expect(chatInputSource).toContain('oc-mobile-composer-compact-chrome--sending');
    expect(chatInputSource).toContain("compactCircleButtonClass = cn(");
  });
});
