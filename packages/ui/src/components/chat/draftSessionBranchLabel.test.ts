import { describe, expect, test } from 'bun:test';
import {
  isDirectoryBasenameLabel,
  resolveDraftSessionBranchLabel,
} from './draftSessionBranchLabel';

describe('resolveDraftSessionBranchLabel', () => {
  test('returns the project root branch name for the project directory', () => {
    expect(resolveDraftSessionBranchLabel({
      selectedDirectory: '/Users/example/Code/github/openchamber',
      projectRootOption: {
        value: '/Users/example/Code/github/openchamber',
        label: 'main',
      },
      worktreeOptions: [],
    })).toBe('main');
  });

  test('returns the worktree branch name for an isolated worktree directory', () => {
    expect(resolveDraftSessionBranchLabel({
      selectedDirectory: '/Users/example/Code/github/openchamber/.worktrees/feat-a',
      projectRootOption: {
        value: '/Users/example/Code/github/openchamber',
        label: 'main',
      },
      worktreeOptions: [
        {
          value: '/Users/example/Code/github/openchamber/.worktrees/feat-a',
          label: 'feat-a',
        },
      ],
    })).toBe('feat-a');
  });

  test('never falls back to a directory basename when the branch is still unknown', () => {
    // Regression: mobile draft chip painted "openchamber" instead of "main"
    // because formatDirectoryName(selectedDirectory) was used as the label.
    expect(resolveDraftSessionBranchLabel({
      selectedDirectory: '/Users/example/Code/github/openchamber',
      projectRootOption: null,
      worktreeOptions: [],
    })).toBeNull();
  });

  test('defaults to the project root branch when no directory is selected yet', () => {
    expect(resolveDraftSessionBranchLabel({
      selectedDirectory: null,
      projectRootOption: {
        value: '/Users/example/Code/github/openchamber',
        label: 'main',
      },
      worktreeOptions: [],
    })).toBe('main');
  });
});

describe('isDirectoryBasenameLabel', () => {
  test('detects when a chip label is just the directory basename', () => {
    expect(isDirectoryBasenameLabel(
      'openchamber',
      '/Users/example/Code/github/openchamber',
    )).toBe(true);
  });

  test('does not treat a real branch name as a directory basename', () => {
    expect(isDirectoryBasenameLabel(
      'main',
      '/Users/example/Code/github/openchamber',
    )).toBe(false);
  });

  test('handles trailing slashes and backslashes', () => {
    expect(isDirectoryBasenameLabel('openchamber', '/Users/example/openchamber/')).toBe(true);
    expect(isDirectoryBasenameLabel('openchamber', 'C:\\Users\\example\\openchamber')).toBe(true);
  });
});
