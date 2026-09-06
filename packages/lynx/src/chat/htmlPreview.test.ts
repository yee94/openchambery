import { describe, expect, test } from 'vitest';

import { isLynxHtmlPath, planLynxHtmlPreview } from './htmlPreview';

describe('Lynx HTML preview stub', () => {
  test('non-html is text fallback', () => {
    expect(isLynxHtmlPath('/a.ts')).toBe(false);
    expect(planLynxHtmlPreview('/a.ts')).toEqual({ mode: 'text', textFallback: true });
  });

  test('html is honest host-required stub', () => {
    expect(isLynxHtmlPath('/docs/index.html')).toBe(true);
    const plan = planLynxHtmlPreview('/docs/index.html');
    expect(plan.mode).toBe('html-stub');
    if (plan.mode === 'html-stub') {
      expect(plan.hostRequired).toBe(true);
      expect(plan.textFallback).toBe(true);
      expect(plan.note).toContain('WKWebView');
    }
  });
});
