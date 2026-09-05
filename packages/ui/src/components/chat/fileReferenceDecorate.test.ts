import { describe, expect, test } from 'vitest';

import {
  copyPreservedFileLinkAttributes,
  wrapMarkdownFileReferenceTokens,
} from './fileReferenceDecorate';

describe('wrapMarkdownFileReferenceTokens', () => {
  test('wraps a bare file path in paragraph text', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>see /tmp/report.html please</p>';
    wrapMarkdownFileReferenceTokens(root);
    const token = root.querySelector('[data-openchamber-block-path-token]');
    expect(token?.textContent).toBe('/tmp/report.html');
  });

  test('wraps a path token inside a fenced code block', () => {
    const root = document.createElement('div');
    root.innerHTML = '<pre><code>/Users/dev/notes.md</code></pre>';
    wrapMarkdownFileReferenceTokens(root);
    const token = root.querySelector('[data-openchamber-block-path-token]');
    expect(token?.textContent).toBe('/Users/dev/notes.md');
  });
});

describe('copyPreservedFileLinkAttributes', () => {
  test('copies file-link attributes when the path text matches', () => {
    const fromEl = document.createElement('span');
    fromEl.textContent = '/tmp/photo.png';
    fromEl.setAttribute('data-openchamber-file-link', 'true');
    fromEl.setAttribute('data-openchamber-file-ref', '/tmp/photo.png');
    fromEl.setAttribute('data-openchamber-file-path', '/tmp/photo.png');
    fromEl.setAttribute('title', 'Open file');

    const toEl = document.createElement('span');
    toEl.textContent = '/tmp/photo.png';

    copyPreservedFileLinkAttributes(fromEl, toEl);
    expect(toEl.getAttribute('data-openchamber-file-link')).toBe('true');
    expect(toEl.getAttribute('data-openchamber-file-path')).toBe('/tmp/photo.png');
  });

  test('does not copy attributes onto a different path token', () => {
    const fromEl = document.createElement('span');
    fromEl.textContent = '/tmp/a.png';
    fromEl.setAttribute('data-openchamber-file-link', 'true');
    fromEl.setAttribute('data-openchamber-file-ref', '/tmp/a.png');

    const toEl = document.createElement('span');
    toEl.textContent = '/tmp/b.png';

    copyPreservedFileLinkAttributes(fromEl, toEl);
    expect(toEl.getAttribute('data-openchamber-file-link')).toBeNull();
  });
});
