import assert from 'node:assert/strict';
import { test } from 'vitest';
import { toGitBashPath } from './git-bash-path.mjs';

test('converts Windows drive paths to Git Bash paths for tar -C', () => {
  assert.equal(toGitBashPath('D:\\a\\yuri\\extract'), '/d/a/yuri/extract');
  assert.equal(toGitBashPath('/Users/runner/work/yuri/extract'), '/Users/runner/work/yuri/extract');
});
