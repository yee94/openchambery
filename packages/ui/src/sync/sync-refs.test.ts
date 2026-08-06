import { expect, test } from 'bun:test';
import { resolveMaterializedSessionDirectory, type MaterializedSessionDirectorySnapshot } from './sync-refs';

const snapshot = (
  sessionIDs: string[],
  hasTranscript: boolean,
): MaterializedSessionDirectorySnapshot => ({
  session: sessionIDs.map((id) => ({ id })) as MaterializedSessionDirectorySnapshot['session'],
  hasTranscript,
});

test('resolves the unique initialized directory with session identity and loaded transcript', () => {
  expect(resolveMaterializedSessionDirectory('ses_loaded', undefined, [
    ['/project-a', snapshot(['ses_loaded'], true)],
    ['/project-b', snapshot(['ses_other'], true)],
  ])).toBe('/project-a');
});

test('prefers the caller directory and leaves ambiguous cross-directory IDs unresolved', () => {
  const snapshots: Array<readonly [string, MaterializedSessionDirectorySnapshot]> = [
    ['/project-a', snapshot(['ses_shared'], true)],
    ['/project-b', snapshot(['ses_shared'], true)],
  ];

  expect(resolveMaterializedSessionDirectory('ses_shared', '/project-b', snapshots)).toBe('/project-b');
  expect(resolveMaterializedSessionDirectory('ses_shared', undefined, snapshots)).toBe(undefined);
});

test('requires both session identity and hasTranscript', () => {
  expect(resolveMaterializedSessionDirectory('ses_missing', undefined, [
    ['/project-a', snapshot(['ses_missing'], false)],
    ['/project-b', snapshot([], true)],
  ])).toBe(undefined);
});
