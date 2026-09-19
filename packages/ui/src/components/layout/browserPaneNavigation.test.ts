import { describe, expect, test } from 'vitest';
import {
  normalizeBrowserUrl,
  resolveBrowserPaneNavigation,
  shouldUseDesktopWebviewBrowser,
} from './browserPaneNavigation';

describe('normalizeBrowserUrl', () => {
  test('normalizes bare hosts and rejects non-http schemes', () => {
    expect(normalizeBrowserUrl('example.com/path')).toBe('https://example.com/path');
    expect(normalizeBrowserUrl('http://localhost:3000/')).toBe('http://localhost:3000/');
    expect(normalizeBrowserUrl('')).toBe('about:blank');
    expect(normalizeBrowserUrl('file:///tmp/x')).toBe('about:blank');
  });
});

describe('resolveBrowserPaneNavigation', () => {
  test('returns null when incoming is empty or already current', () => {
    expect(resolveBrowserPaneNavigation('', 'https://example.com/')).toBe(null);
    expect(resolveBrowserPaneNavigation('about:blank', 'https://example.com/')).toBe(null);
    expect(resolveBrowserPaneNavigation('https://example.com/', 'https://example.com/')).toBe(null);
  });

  test('returns the next URL when parent targetPath changes', () => {
    expect(resolveBrowserPaneNavigation(
      'https://example.com/docs',
      'https://example.com/',
    )).toBe('https://example.com/docs');

    expect(resolveBrowserPaneNavigation(
      'http://localhost:5173/',
      'https://example.com/',
    )).toBe('http://localhost:5173/');
  });
});

describe('shouldUseDesktopWebviewBrowser', () => {
  test('uses native webview only on Electron when Relay is inactive', () => {
    expect(shouldUseDesktopWebviewBrowser({ isElectron: true, relayActive: false })).toBe(true);
    expect(shouldUseDesktopWebviewBrowser({ isElectron: true, relayActive: true })).toBe(false);
    expect(shouldUseDesktopWebviewBrowser({ isElectron: false, relayActive: false })).toBe(false);
    expect(shouldUseDesktopWebviewBrowser({ isElectron: false, relayActive: true })).toBe(false);
  });
});
