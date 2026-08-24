import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));

const readSibling = (name: string) => readFileSync(path.join(here, name), 'utf8');

describe('dialog action typography', () => {
  test('shared Button rides typography-ui-label so confirm actions follow --dpt', () => {
    expect(readSibling('button.tsx')).toContain('typography-ui-label');
  });

  test('UpdateDialog footer actions use Button instead of unscaled text-sm', () => {
    const source = readSibling('UpdateDialog.tsx');
    expect(source).toContain("t('updateDialog.actions.applyOtaNow')");
    expect(source).toContain("t('updateDialog.actions.updateNow')");
    expect(source).toContain("t('updateDialog.actions.restartToUpdate')");
    expect(source).toContain("t('updateDialog.actions.later')");
    expect(source).not.toMatch(
      /<button[\s\S]{0,240}text-sm font-medium[\s\S]{0,160}updateDialog\.actions\.(applyOtaNow|downloadUpdate|updateNow)/,
    );
    expect(source).not.toMatch(
      /<button[\s\S]{0,240}text-sm font-medium[\s\S]{0,160}updateDialog\.status\.(downloading|updating)/,
    );
  });
});
