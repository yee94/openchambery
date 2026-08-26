import morphdom from 'morphdom';
import { describe, expect, test } from 'vitest';

import { animateNewStreamBlock } from './streamBlockAnimation';

describe('streaming Markdown block animation', () => {
  test('animates every rendered top-level child and cleans each child independently', () => {
    const seenIds = new Set<string>();
    const block = document.createElement('div');
    block.innerHTML = '<p>first</p><section>second</section><span style="display: contents"><em>ignored</em></span>';
    const first = block.children[0] as HTMLElement;
    const second = block.children[1] as HTMLElement;
    const contents = block.children[2] as HTMLElement;

    expect(animateNewStreamBlock({
      block,
      id: 'block-a',
      hadBlockId: false,
      seenIds,
      enabled: true,
      staggerIndex: 0,
    })).toBe(2);
    expect(block.classList.contains('oc-stream-animate-fade')).toBe(false);
    expect(first.classList.contains('oc-stream-animate-fade')).toBe(true);
    expect(second.classList.contains('oc-stream-animate-fade')).toBe(true);
    expect(contents.classList.contains('oc-stream-animate-fade')).toBe(false);
    expect(first.style.getPropertyValue('--oc-stream-delay')).toBe('0ms');
    expect(second.style.getPropertyValue('--oc-stream-delay')).toBe('45ms');

    first.dispatchEvent(new Event('animationend', { bubbles: true }));
    expect(first.classList.contains('oc-stream-animate-fade')).toBe(false);
    expect(first.style.getPropertyValue('--oc-stream-delay')).toBe('');
    expect(second.classList.contains('oc-stream-animate-fade')).toBe(true);
    expect(second.style.getPropertyValue('--oc-stream-delay')).toBe('45ms');

    second.dispatchEvent(new Event('animationend', { bubbles: true }));
    expect(second.classList.contains('oc-stream-animate-fade')).toBe(false);
    expect(second.style.getPropertyValue('--oc-stream-delay')).toBe('');

    const repeatedBlock = document.createElement('div');
    repeatedBlock.innerHTML = '<p>repeated</p>';
    expect(animateNewStreamBlock({
      block: repeatedBlock,
      id: 'block-a',
      hadBlockId: false,
      seenIds,
      enabled: true,
      staggerIndex: 0,
    })).toBe(0);

    expect(animateNewStreamBlock({
      block,
      id: 'block-a-growing',
      hadBlockId: true,
      seenIds,
      enabled: true,
      staggerIndex: 0,
    })).toBe(0);
  });

  test('caps stagger delay at the third newly animated block', () => {
    const block = document.createElement('div');
    block.innerHTML = '<p>late</p>';

    animateNewStreamBlock({
      block,
      id: 'block-late',
      hadBlockId: false,
      seenIds: new Set<string>(),
      enabled: true,
      staggerIndex: 8,
    });

    expect((block.firstElementChild as HTMLElement).style.getPropertyValue('--oc-stream-delay')).toBe('90ms');
  });

  test('records disabled blocks without adding animation styles', () => {
    const seenIds = new Set<string>();
    const block = document.createElement('div');
    block.innerHTML = '<p>disabled</p>';

    expect(animateNewStreamBlock({
      block,
      id: 'block-disabled',
      hadBlockId: false,
      seenIds,
      enabled: false,
      staggerIndex: 0,
    })).toBe(0);
    expect(seenIds.has('block-disabled')).toBe(true);
    expect(block.firstElementChild?.classList.contains('oc-stream-animate-fade')).toBe(false);
    expect((block.firstElementChild as HTMLElement).style.getPropertyValue('--oc-stream-delay')).toBe('');
  });

  test('reconciles a replaced animation target without reanimating the growing block', () => {
    const seenIds = new Set<string>();
    const block = document.createElement('div');
    block.innerHTML = '<p>first</p>';
    const first = block.firstElementChild as HTMLElement;
    animateNewStreamBlock({
      block,
      id: 'block-morph',
      hadBlockId: false,
      seenIds,
      enabled: true,
      staggerIndex: 0,
    });

    const next = document.createElement('div');
    next.innerHTML = '<section>updated</section>';
    morphdom(block, next, { childrenOnly: true });
    const replacement = block.firstElementChild as HTMLElement;

    expect(block.textContent).toBe('updated');
    expect(block.contains(first)).toBe(false);
    expect(animateNewStreamBlock({
      block,
      id: 'block-morph-growing',
      hadBlockId: true,
      seenIds,
      enabled: true,
      staggerIndex: 0,
    })).toBe(0);
    expect(first.classList.contains('oc-stream-animate-fade')).toBe(false);
    expect(first.style.getPropertyValue('--oc-stream-delay')).toBe('');
    expect(replacement.classList.contains('oc-stream-animate-fade')).toBe(false);
  });
});
