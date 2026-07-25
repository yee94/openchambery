import { describe, expect, test } from 'bun:test';
import {
  isDirectoryBasenameLabel,
  resolveDraftSessionBranchLabel,
} from './draftSessionBranchLabel';

describe('resolveDraftSessionBranchLabel', () => {
  test('returns the project root branch name for the project directory', () => {
    expect(resolveDraftSessionBranchLabel({
      selectedDirectory: '/Users/yee.wang/Code/github/openchamber-yee',
      projectRootOption: {
        value: '/Users/yee.wang/Code/github/openchamber-yee',
        label: 'main',
      },
      worktreeOptions: [],
    })).toBe('main');
  });

  test('returns the worktree branch name for an isolated worktree directory', () => {
    expect(resolveDraftSessionBranchLabel({
      selectedDirectory: '/Users/yee.wang/Code/github/openchamber-yee/.worktrees/feat-a',
      projectRootOption: {
        value: '/Users/yee.wang/Code/github/openchamber-yee',
        label: 'main',
      },
      worktreeOptions: [
        {
          value: '/Users/yee.wang/Code/github/openchamber-yee/.worktrees/feat-a',
          label: 'feat-a',
        },
      ],
    })).toBe('feat-a');
  });

  test('never falls back to a directory basename when the branch is still unknown', () => {
    // Regression: mobile draft chip painted "openchamber-yee" instead of "main"
    // because formatDirectoryName(selectedDirectory) was used as the label.
    expect(resolveDraftSessionBranchLabel({
      selectedDirectory: '/Users/yee.wang/Code/github/openchamber-yee',
      projectRootOption: null,
      worktreeOptions: [],
    })).toBeNull();
  });

  test('defaults to the project root branch when no directory is selected yet', () => {
    expect(resolveDraftSessionBranchLabel({
      selectedDirectory: null,
      projectRootOption: {
        value: '/Users/yee.wang/Code/github/openchamber-yee',
        label: 'main',
      },
      worktreeOptions: [],
    })).toBe('main');
  });
});

describe('isDirectoryBasenameLabel', () => {
  test('detects when a chip label is just the directory basename', () => {
    expect(isDirectoryBasenameLabel(
      'openchamber-yee',
      '/Users/yee.wang/Code/github/openchamber-yee',
    )).toBe(true);
  });

  test('does not treat a real branch name as a directory basename', () => {
    expect(isDirectoryBasenameLabel(
      'main',
      '/Users/yee.wang/Code/github/openchamber-yee',
    )).toBe(false);
  });

  test('handles trailing slashes and backslashes', () => {
    expect(isDirectoryBasenameLabel('openchamber-yee', '/Users/yee/openchamber-yee/')).toBe(true);
    expect(isDirectoryBasenameLabel('openchamber-yee', 'C:\\Users\\yee\\openchamber-yee')).toBe(true);
  });
});
