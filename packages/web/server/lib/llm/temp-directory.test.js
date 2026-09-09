import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureLlmTempDirectory, stopLlmTempDirectory } from './temp-directory.js';

const readAgent = async (root, agentName) =>
  fs.readFile(path.join(root, '.opencode', 'agent', `${agentName}.md`), 'utf8');

afterEach(async () => {
  await stopLlmTempDirectory();
});

describe('ensureLlmTempDirectory', () => {
  it('shares one directory across concurrent first ensures and applies each markdown body', async () => {
    const firstBody = '---\nname: a\n---\nFIRST\n';
    const secondBody = '---\nname: a\n---\nSECOND\n';
    const [first, second] = await Promise.all([
      ensureLlmTempDirectory({ agentName: 'openchamber-llm', agentMarkdown: firstBody }),
      ensureLlmTempDirectory({ agentName: 'openchamber-llm', agentMarkdown: secondBody }),
    ]);
    expect(first).toBe(second);
    const written = await readAgent(first, 'openchamber-llm');
    // Last writer wins; both callers must have completed a full write after settle.
    expect(written === firstBody || written === secondBody).toBe(true);
    expect(written).toMatch(/FIRST|SECOND/);
  });

  it('refreshes markdown on a warm directory under concurrent ensure', async () => {
    const root = await ensureLlmTempDirectory({
      agentName: 'openchamber-llm',
      agentMarkdown: '---\nname: a\n---\nSEED\n',
    });
    const bodies = Array.from({ length: 8 }, (_, index) => `---\nname: a\n---\nREFRESH-${index}\n`);
    const roots = await Promise.all(
      bodies.map((agentMarkdown) => ensureLlmTempDirectory({ agentName: 'openchamber-llm', agentMarkdown })),
    );
    expect(new Set(roots)).toEqual(new Set([root]));
    const written = await readAgent(root, 'openchamber-llm');
    expect(bodies).toContain(written);
    expect(written).toMatch(/REFRESH-\d+/);
  });

  it('stop clears the singleton so the next ensure creates a fresh directory', async () => {
    const first = await ensureLlmTempDirectory({
      agentName: 'openchamber-llm',
      agentMarkdown: '---\nname: a\n---\nA\n',
    });
    await stopLlmTempDirectory();
    const second = await ensureLlmTempDirectory({
      agentName: 'openchamber-llm',
      agentMarkdown: '---\nname: a\n---\nB\n',
    });
    expect(second).not.toBe(first);
    await expect(fs.access(first)).rejects.toThrow();
    expect(await readAgent(second, 'openchamber-llm')).toContain('B');
  });
});
