import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const selectSource = readFileSync(join(__dirname, 'select.tsx'), 'utf-8');

describe('Select presentation contract', () => {
  test('uses the standard compact mobile picker sheet', () => {
    expect(selectSource).toContain('import { MobileResizableSheet } from "@/components/ui/MobileResizableSheet";');
    expect(selectSource).toContain('id={`mobile-select-sheet-${mobileSheetId}`}');
    expect(selectSource).toContain('fitContent');
    expect(selectSource).toContain('fillContainer={false}');
    expect(selectSource).toContain('outerClassName="max-h-[calc(72dvh-5rem)]"');
    expect(selectSource).toContain('disableHorizontal');
    expect(selectSource).toContain('preventOverscroll');
  });

  test('retains desktop collision handling', () => {
    expect(selectSource).toContain('<BaseSelect.Portal');
    expect(selectSource).toContain('collisionPadding={collisionPadding}');
    expect(selectSource).toContain('collisionPadding = 8');
    expect(selectSource).toContain('collisionAvoidance = { side: "shift", align: "shift" }');
    expect(selectSource).toContain('collisionAvoidance={collisionAvoidance}');
  });
});
