import { describe, expect, test } from 'vitest';

import {
  formatLynxPermissionMetadataLabel,
  formatLynxPermissionMetadataLines,
  formatLynxPermissionMetadataText,
  getLynxPermissionToolDisplayName,
  normalizeLynxPermissionMetadataKey,
} from './permissionMetadata';

describe('Lynx permission metadata (Cap PermissionCard plain text)', () => {
  test('normalizes Cap metadata keys like PermissionCard', () => {
    expect(normalizeLynxPermissionMetadataKey('filepath')).toBe('filePath');
    expect(normalizeLynxPermissionMetadataKey('file_path')).toBe('filePath');
    expect(normalizeLynxPermissionMetadataKey('parentDir')).toBe('parentDirectory');
    expect(formatLynxPermissionMetadataLabel('filePath')).toBe('File Path');
    expect(formatLynxPermissionMetadataLabel('parentDirectory')).toBe('Parent Directory');
  });

  test('bash tool content is plain text (no highlighter)', () => {
    const lines = formatLynxPermissionMetadataLines({
      permission: 'bash',
      metadata: {
        description: 'List files',
        cwd: '/repo',
        timeout: 5000,
        command: 'ls -la',
      },
    });
    expect(lines).toEqual([
      { label: 'Description', value: 'List files' },
      { label: 'Working directory', value: '/repo' },
      { label: 'Timeout', value: '5000ms' },
      { label: 'Command', value: 'ls -la' },
    ]);
    expect(getLynxPermissionToolDisplayName('shell_command')).toBe('bash');
  });

  test('edit / write / webfetch / generic Cap branches', () => {
    expect(formatLynxPermissionMetadataText({
      permission: 'edit',
      metadata: { file_path: 'a.ts', changes: '-a\n+b', replace_all: true },
    })).toContain('File Path: a.ts');

    expect(formatLynxPermissionMetadataText({
      permission: 'write',
      metadata: { path: 'b.ts', content: 'hello' },
    })).toContain('Content: hello');

    expect(formatLynxPermissionMetadataText({
      permission: 'webfetch',
      metadata: { url: 'https://example.com', method: 'POST', headers: { a: '1' }, body: { x: 1 } },
    })).toContain('Request: POST https://example.com');

    const generic = formatLynxPermissionMetadataLines({
      permission: 'external_directory',
      metadata: {
        filepath: '/Library/Logs/DiagnosticReports',
        parentDir: '/Library/Logs',
        always: ['ignored'],
      },
    });
    expect(generic.map((line) => line.label)).toEqual(['File Path', 'Parent Directory']);
    expect(generic.map((line) => line.value)).toEqual([
      '/Library/Logs/DiagnosticReports',
      '/Library/Logs',
    ]);
  });
});
