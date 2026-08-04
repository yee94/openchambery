/**
 * Regression: Activity tool rows flash during multi-step assistant inference.
 *
 * Captured evidence: Trace-20260804T171706.json.gz
 * - directory: assistant-workspaces/...
 * - session: ses_03431f1c4ffeq7mFAADhDYG5Lc
 * - Within ~4.5s of one prompt_async: 5× GET .../messages (materialize thrash)
 * - UI: shell tool rows appear then vanish while "正在处理", Activity header count
 *   briefly drops (live turn unmount), then remounts collapsed.
 *
 * Causal chain locked here as pure unit contracts (no browser):
 * 1. Trailing open assistant without parts must stay renderable → ensure gate off
 * 2. Lagging HTTP materialize must not drop SSE tools on an open message
 * 3. Multi-step prefix assistants stay visible while a later sibling streams
 * 4. Last open turn stays expanded across sessionIsWorking busy/idle flaps
 * 5. Settled turn may collapse under activityRenderMode=collapsed
 * 6. Live-tail claim survives an empty projection frame (no turn eviction)
 * 7. The streaming tail is mounted unconditionally (no subtree destroy on empty)
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';

import { shouldEnsureChatSessionRenderable } from './chatSessionMaterialization';
import { resolveLiveTailStart, splitTurnRecordsByLiveTail } from './hooks/useTurnRecords';
import type { TurnRecord } from './lib/turns/types';
import {
  resolveActivityExpansionDisposition,
  resolveDefaultActivityExpanded,
  resolveTurnActivityPresentation,
} from './lib/activityExpansion';
import { resolveVisibleSortedAssistants } from './lib/visibleSortedAssistants';
import type { ChatMessageEntry } from './lib/turns/types';
import { getSessionMaterializationStatus, materializeSessionSnapshots } from '@/sync/materialization';

const sessionID = 'ses_03431f1c4ffeq7mFAADhDYG5Lc';

const user = (id: string): Message =>
  ({ id, sessionID, role: 'user', time: { created: 1 } }) as Message;

const openAssistant = (id: string): Message =>
  ({ id, sessionID, role: 'assistant', time: { created: 2 } }) as Message;

const settledAssistant = (id: string): Message =>
  ({
    id,
    sessionID,
    role: 'assistant',
    finish: 'stop',
    time: { created: 2, completed: 99 },
  }) as Message;

const textPart = (id: string, messageID: string, text: string): Part =>
  ({ id, messageID, sessionID, type: 'text', text }) as Part;

const toolPart = (
  id: string,
  messageID: string,
  tool: string,
  status: 'running' | 'completed',
): Part =>
  ({
    id,
    messageID,
    sessionID,
    type: 'tool',
    tool,
    state:
      status === 'running'
        ? { status, input: { command: 'ls' }, time: { start: 10 } }
        : {
            status,
            input: { command: 'ls' },
            output: 'ok',
            time: { start: 10, end: 20 },
          },
  }) as unknown as Part;

const entry = (id: string, completed?: number): ChatMessageEntry => ({
  info: {
    id,
    role: 'assistant',
    sessionID,
    time: completed !== undefined ? { created: 1, completed } : { created: 1 },
  } as Message,
  parts: [],
});

describe('activity tool flicker regression (Trace-20260804T171706)', () => {
  test('1. trailing open assistant without parts keeps session renderable (stops ensure thrash)', () => {
    // SSE: message.updated for trailing assistant before any part.updated.
    const state = {
      message: {
        [sessionID]: [user('msg_user'), openAssistant('msg_asst_open')],
      },
      part: {
        msg_user: [textPart('prt_u', 'msg_user', 'run three shells')],
      },
    };

    const status = getSessionMaterializationStatus(state, sessionID);
    expect(status.renderable).toBe(true);
    expect(status.missingPartMessageIDs).toEqual([]);

    // ChatContainer only ensureSessionRenderable when NOT (renderable && entity).
    // With entity present + renderable, gate is closed — no thrash GET /messages.
    expect(
      shouldEnsureChatSessionRenderable({
        sessionId: sessionID,
        hasRenderableSessionSnapshot: status.renderable,
        hasCurrentSessionEntity: true,
      }),
    ).toBe(false);
  });

  test('1b. without the trailing-open exception, a cold settled assistant still blocks renderable', () => {
    const state = {
      message: { [sessionID]: [settledAssistant('msg_done')] },
      part: {},
    };
    const status = getSessionMaterializationStatus(state, sessionID);
    expect(status.renderable).toBe(false);
    expect(status.missingPartMessageIDs).toEqual(['msg_done']);
    expect(
      shouldEnsureChatSessionRenderable({
        sessionId: sessionID,
        hasRenderableSessionSnapshot: status.renderable,
        hasCurrentSessionEntity: true,
      }),
    ).toBe(true);
  });

  test('2. multi-step timeline: open trailing never flips renderable false between tools', () => {
    // Simulate the live store across one multi-tool turn (trace: tools A→D).
    let state = {
      message: {
        [sessionID]: [user('msg_user'), openAssistant('msg_asst')],
      },
      part: {
        msg_user: [textPart('prt_u', 'msg_user', 'shells')],
      },
    };

    // Step: first tool arrives via SSE
    state = {
      ...state,
      part: {
        ...state.part,
        msg_asst: [toolPart('prt_t1', 'msg_asst', 'bash', 'completed')],
      },
    };
    expect(getSessionMaterializationStatus(state, sessionID).renderable).toBe(true);

    // Step: second tool; lagging materialize page omits tools (only empty/partial)
    state = {
      ...state,
      part: {
        ...state.part,
        msg_asst: [
          toolPart('prt_t1', 'msg_asst', 'bash', 'completed'),
          toolPart('prt_t2', 'msg_asst', 'bash', 'running'),
        ],
      },
    };
    expect(getSessionMaterializationStatus(state, sessionID).renderable).toBe(true);

    // Lagging GET /messages mid-turn (as in the trace) must not erase tools.
    const afterLag = materializeSessionSnapshots(
      state,
      sessionID,
      [{
        info: openAssistant('msg_asst'),
        parts: [textPart('prt_reason', 'msg_asst', 'thinking...')],
      }],
    );
    const ids = afterLag.part.msg_asst.map((p) => p.id).sort();
    expect(ids).toEqual(['prt_reason', 'prt_t1', 'prt_t2']);
    expect(getSessionMaterializationStatus(afterLag, sessionID).renderable).toBe(true);
    expect(
      shouldEnsureChatSessionRenderable({
        sessionId: sessionID,
        hasRenderableSessionSnapshot: true,
        hasCurrentSessionEntity: true,
      }),
    ).toBe(false);
  });

  test('3. sorted multi-step: earlier incomplete assistants stay visible while later streams', () => {
    const a1 = entry('a1'); // tools ran; completion metadata lagging
    const a2 = entry('a2'); // streaming
    expect(resolveVisibleSortedAssistants([a1, a2], 'a2').map((e) => e.info.id)).toEqual([
      'a1',
      'a2',
    ]);
  });

  test('4. last open turn stays expanded across sessionIsWorking busy→idle→busy flaps', () => {
    const activityRenderMode = 'collapsed' as const;
    const turnDisposition = 'active' as const;

    for (const sessionIsWorking of [true, false, true, false]) {
      const header = resolveTurnActivityPresentation({
        completionDisposition: turnDisposition,
        isLastTurn: true,
        sessionIsWorking,
      });
      // Header chrome may demote to abnormal when idle (stops Working shimmer).
      if (!sessionIsWorking) {
        expect(header.completionDisposition).toBe('abnormal');
      }

      const expansionDisposition = resolveActivityExpansionDisposition({
        isLastTurn: true,
        turnCompletionDisposition: turnDisposition,
        headerPresentationDisposition: header.completionDisposition,
      });
      // Expansion path always keeps active for the last open turn.
      expect(expansionDisposition).toBe('active');
      expect(resolveDefaultActivityExpanded(expansionDisposition, activityRenderMode)).toBe(true);
    }
  });

  test('5. after the turn settles, collapsed mode may auto-fold (not a mid-turn flicker)', () => {
    const header = resolveTurnActivityPresentation({
      completionDisposition: 'normal',
      isLastTurn: true,
      sessionIsWorking: false,
    });
    expect(header.completionDisposition).toBe('normal');

    const expansionDisposition = resolveActivityExpansionDisposition({
      isLastTurn: true,
      turnCompletionDisposition: 'normal',
      headerPresentationDisposition: header.completionDisposition,
    });
    expect(expansionDisposition).toBe('normal');
    expect(resolveDefaultActivityExpanded(expansionDisposition, 'collapsed')).toBe(false);
    expect(resolveDefaultActivityExpanded(expansionDisposition, 'summary')).toBe(true);
  });

  test('6. full ensure-gate sequence matching ChatContainer effect inputs', () => {
    // Cold: no entity, not renderable → ensure
    expect(
      shouldEnsureChatSessionRenderable({
        sessionId: sessionID,
        hasRenderableSessionSnapshot: false,
        hasCurrentSessionEntity: false,
      }),
    ).toBe(true);

    // Live mid-turn after trailing open assistant lands without parts:
    // renderable true + entity present → must NOT ensure (trace thrash root).
    const midTurn = {
      message: {
        [sessionID]: [user('u1'), openAssistant('a1')],
      },
      part: { u1: [textPart('p_u', 'u1', 'hi')] },
    };
    const midStatus = getSessionMaterializationStatus(midTurn, sessionID);
    expect(midStatus.renderable).toBe(true);
    expect(
      shouldEnsureChatSessionRenderable({
        sessionId: sessionID,
        hasRenderableSessionSnapshot: midStatus.renderable,
        hasCurrentSessionEntity: true,
      }),
    ).toBe(false);

    // Settled history row without parts + entity → ensure once for repair
    const settledGap = {
      message: { [sessionID]: [settledAssistant('a_done')] },
      part: {},
    };
    const settledStatus = getSessionMaterializationStatus(settledGap, sessionID);
    expect(settledStatus.renderable).toBe(false);
    expect(
      shouldEnsureChatSessionRenderable({
        sessionId: sessionID,
        hasRenderableSessionSnapshot: settledStatus.renderable,
        hasCurrentSessionEntity: true,
      }),
    ).toBe(true);
  });

  test('7. an empty projection frame does not evict turns out of the live tail', () => {
    // Trace evidence: StreamingTailContent mounted 17× and unmounted 42× in 11s,
    // with ChatMessage/MessageRow/TurnBlock recorded as Mount (not Update) at each
    // GET .../messages. A turn that migrates between StaticHistoryList and the tail
    // is rebuilt from an empty node, which is what read as "the message vanished".
    const turn = (turnId: string): TurnRecord => ({ turnId } as TurnRecord);
    const turns = [turn('t1'), turn('t2'), turn('t3')];

    const claimed = resolveLiveTailStart({
      turnCount: turns.length,
      hasLiveTail: true,
      liveTailActive: true,
      previousStart: null,
    });
    expect(splitTurnRecordsByLiveTail(turns, claimed).streamingTurns).toEqual([turn('t3')]);

    // Mid-turn materialize empties the projection for one frame.
    const throughEmpty = resolveLiveTailStart({
      turnCount: 0,
      hasLiveTail: true,
      liveTailActive: true,
      previousStart: claimed,
    });

    // The next frame restores the same ownership split; t3 never migrated.
    const restored = resolveLiveTailStart({
      turnCount: turns.length,
      hasLiveTail: true,
      liveTailActive: true,
      previousStart: throughEmpty,
    });
    expect(restored).toBe(claimed);
    expect(splitTurnRecordsByLiveTail(turns, restored)).toEqual({
      staticTurns: [turn('t1'), turn('t2')],
      streamingTurns: [turn('t3')],
    });
  });

  test('8. the streaming tail is mounted unconditionally', () => {
    // Structural guard: gating the tail on a non-empty entry list destroys the
    // whole streaming subtree on any empty frame, which no pure unit test can
    // observe. Keep the JSX unconditional so the fiber, its useSessionParts
    // subscription and its DOM survive.
    const source = readFileSync(fileURLToPath(new URL('./MessageList.tsx', import.meta.url)), 'utf8');
    expect(source).not.toContain('hasTrailingStreamingEntries ? (');
    expect(source).toContain('<StreamingTailContent');
  });
});
