import { describe, expect, it } from 'vitest';

import {
  createTranscriptController,
  extractTextFromParts,
  type TranscriptRow,
} from '@/lib/chatTranscript';
import type { ChatMessageRecord } from '@/lib/sessionMessages';
import { safeStreamingMarkdownText } from '@/lib/streamingMarkdown';

/** 关3 fixture: ~250 turns / 500 messages, large fences, reasoning every 3rd. */
function buildLongFixture(turns = 250): ChatMessageRecord[] {
  const records: ChatMessageRecord[] = [];
  for (let t = 0; t < turns; t += 1) {
    const userId = `u_${t}`;
    const asstId = `a_${t}`;
    records.push({
      info: { id: userId, role: 'user', time: { created: t * 2 } },
      parts: [{ type: 'text', text: `User turn ${t}: ${'x'.repeat(40)}` }],
    });
    const code = '```ts\n' + `const n${t} = ${t};\n`.repeat(20) + '```\n';
    const reasoning =
      t % 3 === 0
        ? [{ type: 'reasoning', text: `think ${t} ` + 'y'.repeat(200) }]
        : [];
    records.push({
      info: { id: asstId, role: 'assistant', time: { created: t * 2 + 1 } },
      parts: [
        ...reasoning,
        { type: 'text', text: `Assistant ${t}\n${code}` + 'z'.repeat(80) },
      ],
    });
  }
  return records;
}

describe('chat transcript perf harness (关3)', () => {
  it('loads long fixture without O(n^2) structure thrash on identical apply', () => {
    const records = buildLongFixture(250);
    expect(records.length).toBe(500);

    const controller = createTranscriptController();
    controller.replaceFromRecords(records);
    const epoch1 = controller.getState().structure.structureEpoch;
    expect(controller.getRows()).toHaveLength(500);

    controller.resetStats();
    controller.applyIdentical(records);
    expect(controller.getStats().structureRebuilds).toBe(0);
    expect(controller.getState().structure.structureEpoch).toBe(epoch1);
  });

  it('SSE token updates do not rebuild list structure / neighbor ids', () => {
    const records = buildLongFixture(50);
    const controller = createTranscriptController();
    controller.replaceFromRecords(records);
    const beforeIds = controller.getState().structure.ids.slice();
    const epoch = controller.getState().structure.structureEpoch;
    const liveId = beforeIds.at(-1)!;
    controller.resetStats();

    const neighborBefore = beforeIds.slice(0, -1);
    for (let i = 0; i < 40; i += 1) {
      controller.upsertLiveTail(liveId, `token-${i}-` + 'a'.repeat(i), 'assistant');
    }

    expect(controller.getStats().structureRebuilds).toBe(0);
    expect(controller.getState().structure.structureEpoch).toBe(epoch);
    expect(controller.getState().structure.ids).toEqual(beforeIds);
    expect(controller.getState().structure.ids.slice(0, -1)).toEqual(neighborBefore);
    expect(controller.getStats().liveOnlyUpdates).toBe(40);

    // Memo-style neighbor check: completed neighbor text unchanged.
    const rows = controller.getRows();
    const neighbor = rows[rows.length - 2];
    expect(neighbor?.streaming).toBe(false);
    expect(neighbor?.text).toBe(extractTextFromParts(records[records.length - 2]!.parts));
  });

  it('incomplete fence on live tail stays safe under paced updates', () => {
    const controller = createTranscriptController();
    controller.replaceFromRecords([
      { info: { id: 'u1', role: 'user' }, parts: [{ type: 'text', text: 'go' }] },
    ]);
    const chunks = [
      'Here\n```ts\n',
      'Here\n```ts\nconst x = 1\n',
      'Here\n```ts\nconst x = 1\ncon',
      'Here\n```ts\nconst x = 1\nconsole.log(x)\n```\n',
    ];
    for (const chunk of chunks) {
      expect(() => {
        controller.upsertLiveTail('a1', chunk, 'assistant');
        const row = controller.getRows().find((r: TranscriptRow) => r.id === 'a1');
        safeStreamingMarkdownText(row?.text ?? '', true);
      }).not.toThrow();
    }
  });
});
