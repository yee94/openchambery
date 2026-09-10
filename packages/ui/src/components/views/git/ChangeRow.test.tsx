import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { I18nProvider } from '@/lib/i18n';
import type { GitStatus } from '@/lib/api/types';

import { ChangeRow } from './ChangeRow';
import { getChangesTreeFileName } from './changesTree';

const file = (path: string): GitStatus['files'][number] => ({
  path,
  index: ' ',
  working_dir: 'M',
});

function renderRow(path: string, displayPath?: string) {
  return renderToStaticMarkup(
    <I18nProvider>
      <ChangeRow
        file={file(path)}
        actionLabel={`Stage ${path}`}
        actionSymbol="+"
        onAction={() => undefined}
        onViewDiff={() => undefined}
        onRevert={() => undefined}
        isReverting={false}
        displayPath={displayPath}
      />
    </I18nProvider>,
  );
}

describe('ChangeRow path labels', () => {
  test('keeps the parent directory in the flat-view label', () => {
    const markup = renderRow('response/i.ts');

    expect(markup).toContain('title="response/i.ts"');
    expect(markup).toContain('shrink-0 text-muted-foreground">response');
  });

  test('tree view shows only the basename while hover keeps the full path', () => {
    const markup = renderRow('response/i.ts', getChangesTreeFileName('response/i.ts'));

    expect(markup).toContain('title="response/i.ts"');
    expect(markup).not.toContain('shrink-0 text-muted-foreground">response');
  });
});
