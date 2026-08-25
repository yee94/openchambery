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
 * 5. Settled turn may collapse under activityRenderMode=collapsed (history only)
 * 5b. Turn-completion chrome (footer) needs both the projection and session status
 * 6. Live-tail claim survives an empty projection frame (no turn eviction)
 * 7. The streaming tail is mounted unconditionally (no subtree destroy on empty)
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';

import { shouldEnsureChatSessionRenderable } from './chatSessionMaterialization';
import { resolveLiveTailStart, splitTurnRecordsByLiveTail } from './hooks/useTurnRecords';
import type { TurnRecord } from './lib/turns/types';
import {
  resolveActivityExpansionDisposition,
  resolveDefaultActivityExpanded,
  resolveTurnActivityPresentation,
  resolveTurnSettledForPresentation,
} from './lib/activityExpansion';
import { projectTurnActivity } from './lib/turns/projectTurnActivity';
import { projectTurnRecords } from './lib/turns/projectTurnRecords';
import { resolveVisibleSortedAssistants } from './lib/visibleSortedAssistants';
import type { ChatMessageEntry } from './lib/turns/types';
import { getSessionMaterializationStatus, materializeSessionSnapshots, type MaterializedState } from '@/sync/materialization';

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
    let state: MaterializedState = {
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
            hasAssistantMessages: true,
      });
      // Expansion path always keeps active for the last open turn.
      expect(expansionDisposition).toBe('active');
      expect(resolveDefaultActivityExpanded(expansionDisposition, activityRenderMode)).toBe(true);
    }
  });

  test('4b. the last turn auto-collapses only once its final body is confirmed', () => {
    // A multi-step turn reads settled for the gap between one step's finish and
    // the next assistant message. Auto-collapsing in that gap unmounted the
    // nested tool rows and re-expanded them a frame later, so the newest turn
    // opts out of auto-collapse until the projection confirms a terminal stop
    // with a model-produced final text (hasConfirmedFinalBody).
    for (const disposition of ['active', 'normal', 'abnormal'] as const) {
      expect(
        resolveDefaultActivityExpanded(disposition, 'collapsed', {
          isLastTurn: true,
          hasConfirmedFinalBody: false,
        }),
      ).toBe(true);
    }
    // Once the final body is confirmed, the untouched last turn follows the
    // configured render mode like any settled turn.
    expect(
      resolveDefaultActivityExpanded('normal', 'collapsed', {
        isLastTurn: true,
        hasConfirmedFinalBody: true,
      }),
    ).toBe(false);
    expect(
      resolveDefaultActivityExpanded('normal', 'summary', {
        isLastTurn: true,
        hasConfirmedFinalBody: true,
      }),
    ).toBe(true);
  });

  test('4d. the completed-turn footer stays hidden through a multi-step step gap', () => {
    // Trace-20260805T182806: the turn footer (duration, TPS, actions) appeared for
    // a few frames mid-loop and withdrew. The footer used to ask the last assistant
    // message whether it was done, and a multi-step agent stamps finish/completed
    // when one shell step ends — while that message is still the turn's last
    // assistant. Turn-completion chrome must ask the turn, and must not believe the
    // projection alone during the gap, because the projection settles there too.
    // Step-gap assistants lack hasConfirmedFinalBody (continuation tool / no final
    // body), so omit hasConfirmedSettledAssistant — same as the MessageList wire.
    const settled = { completionDisposition: 'normal' as const, isLastTurn: true };

    // Step gap on the live turn: the projection reads settled, the session does not.
    expect(resolveTurnSettledForPresentation({ ...settled, sessionIsWorking: true })).toBe(false);
    // Still streaming this step.
    expect(
      resolveTurnSettledForPresentation({
        completionDisposition: 'active',
        isLastTurn: true,
        sessionIsWorking: false,
      }),
    ).toBe(false);
    // The loop really ended.
    expect(resolveTurnSettledForPresentation({ ...settled, sessionIsWorking: false })).toBe(true);
    // History is never suppressed by a later turn's work.
    expect(
      resolveTurnSettledForPresentation({
        completionDisposition: 'abnormal',
        isLastTurn: false,
        sessionIsWorking: true,
      }),
    ).toBe(true);
    // Authoritative final body (live SSE settle) may show chrome before
    // sessionIsWorking flips — not a step-gap; step gaps lack this signal.
    expect(
      resolveTurnSettledForPresentation({
        ...settled,
        sessionIsWorking: true,
        hasConfirmedSettledAssistant: true,
      }),
    ).toBe(true);
  });

  test('4c. multi-step: completed-only assistant filter must not drop the open sibling', () => {
    // User observation: a mid-turn "finished" filter blanks nested fold content.
    // resolveVisibleSortedAssistants previously returned completed-only when the
    // stream id was missing between shells.
    const open = {
      info: { id: 'a_open', role: 'assistant', sessionID: 's', time: { created: 2 } },
      parts: [],
    };
    const done = {
      info: { id: 'a_done', role: 'assistant', sessionID: 's', time: { created: 1, completed: 10 } },
      parts: [],
    };
    expect(
      resolveVisibleSortedAssistants([done as never, open as never], null).map((e) => e.info.id),
    ).toEqual(['a_done', 'a_open']);
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
            hasAssistantMessages: true,
    });
    expect(expansionDisposition).toBe('normal');
    // Settled turns follow the render mode. The newest turn keeps its stability
    // exemption until a confirmed final body makes this transition authoritative.
    expect(resolveDefaultActivityExpanded(expansionDisposition, 'collapsed')).toBe(false);
    expect(resolveDefaultActivityExpanded(expansionDisposition, 'summary')).toBe(true);
    expect(
      resolveDefaultActivityExpanded(expansionDisposition, 'collapsed', { isLastTurn: true }),
    ).toBe(true);
    expect(
      resolveDefaultActivityExpanded(expansionDisposition, 'collapsed', {
        isLastTurn: true,
        hasConfirmedFinalBody: true,
      }),
    ).toBe(false);
  });

  test('5c. three-frame settle: stop+continuation tool stays open until a confirmed final body folds it', () => {
    // Full public seam: projectTurnRecords → resolveActivityExpansionDisposition
    // → resolveDefaultActivityExpanded. OpenCode runLoop semantics say a stop
    // with a completed ordinary tool is still continuation work, so the last
    // turn must not auto-collapse until a later assistant confirms the final
    // body (terminal stop + real text + zero continuation tools).
    const expansionFor = (turns: ReturnType<typeof projectTurnRecords>['turns']) => {
      const turn = turns[turns.length - 1];
      if (!turn) throw new Error('expected a turn');
      const header = resolveTurnActivityPresentation({
        completionDisposition: turn.completionDisposition,
        isLastTurn: true,
        sessionIsWorking: true,
      });
      const disposition = resolveActivityExpansionDisposition({
        isLastTurn: true,
        turnCompletionDisposition: turn.completionDisposition,
        headerPresentationDisposition: header.completionDisposition,
            hasAssistantMessages: true,
      });
      return {
        completionDisposition: turn.completionDisposition,
        hasConfirmedFinalBody: turn.hasConfirmedFinalBody,
        expanded: resolveDefaultActivityExpanded(disposition, 'collapsed', {
          isLastTurn: true,
          hasConfirmedFinalBody: turn.hasConfirmedFinalBody,
        }),
      };
    };

    const userEntry: ChatMessageEntry = {
      info: user('u1'),
      parts: [textPart('p_u', 'u1', 'run the checks')],
    };
    const stepEntry = (id: string, info: Message, parts: Part[]): ChatMessageEntry => ({
      info: { ...info, parentID: 'u1' } as Message,
      parts,
    });

    // Frame 1: last assistant stop + completed ordinary tool + intermediate text.
    const frame1 = projectTurnRecords([
      userEntry,
      stepEntry(
        'a1',
        {
          id: 'a1', sessionID, role: 'assistant', finish: 'stop',
          time: { created: 2, completed: 30 },
        } as Message,
        [toolPart('t1', 'a1', 'bash', 'completed'), textPart('p1', 'a1', 'running the checks')],
      ),
    ]).turns;
    expect(expansionFor(frame1)).toEqual({
      completionDisposition: 'active',
      hasConfirmedFinalBody: false,
      expanded: true,
    });

    // Frame 2: next assistant streams without a finish.
    const frame2 = projectTurnRecords([
      userEntry,
      stepEntry(
        'a1',
        {
          id: 'a1', sessionID, role: 'assistant', finish: 'stop',
          time: { created: 2, completed: 30 },
        } as Message,
        [toolPart('t1', 'a1', 'bash', 'completed'), textPart('p1', 'a1', 'running the checks')],
      ),
      stepEntry(
        'a2',
        { id: 'a2', sessionID, role: 'assistant', time: { created: 31 } } as Message,
        [],
      ),
    ]).turns;
    expect(expansionFor(frame2)).toEqual({
      completionDisposition: 'active',
      hasConfirmedFinalBody: false,
      expanded: true,
    });

    // Frame 3: next assistant stops with real text and zero continuation tools.
    const frame3 = projectTurnRecords([
      userEntry,
      stepEntry(
        'a1',
        {
          id: 'a1', sessionID, role: 'assistant', finish: 'stop',
          time: { created: 2, completed: 30 },
        } as Message,
        [toolPart('t1', 'a1', 'bash', 'completed'), textPart('p1', 'a1', 'running the checks')],
      ),
      stepEntry(
        'a2',
        {
          id: 'a2', sessionID, role: 'assistant', finish: 'stop',
          time: { created: 31, completed: 60 },
        } as Message,
        [textPart('p2', 'a2', 'all checks passed')],
      ),
    ]).turns;
    expect(expansionFor(frame3)).toEqual({
      completionDisposition: 'normal',
      hasConfirmedFinalBody: true,
      expanded: false,
    });
  });

  test('5e. insert-only idle snapshot fills finish so the last turn can auto-collapse', () => {
    const answer = textPart('p1', 'a1', 'the answer');
    const liveAssistant = { ...openAssistant('a1'), parentID: 'u1' } as Message;
    const liveState = {
      message: { [sessionID]: [user('u1'), liveAssistant] },
      part: {
        u1: [textPart('p_u', 'u1', 'summarize')],
        a1: [answer],
      },
    };

    const expansionForState = (state: { message: Record<string, Message[]>; part: Record<string, Part[]> }) => {
      const messages: ChatMessageEntry[] = (state.message[sessionID] ?? []).map((info) => ({
        info,
        parts: state.part[info.id] ?? [],
      }));
      const turn = projectTurnRecords(messages).turns[0];
      if (!turn) throw new Error('expected a turn');
      const header = resolveTurnActivityPresentation({
        completionDisposition: turn.completionDisposition,
        isLastTurn: true,
        sessionIsWorking: false,
      });
      const disposition = resolveActivityExpansionDisposition({
        isLastTurn: true,
        turnCompletionDisposition: turn.completionDisposition,
        headerPresentationDisposition: header.completionDisposition,
            hasAssistantMessages: true,
      });
      return {
        completionDisposition: turn.completionDisposition,
        hasConfirmedFinalBody: turn.hasConfirmedFinalBody,
        expanded: resolveDefaultActivityExpanded(disposition, 'collapsed', {
          isLastTurn: true,
          hasConfirmedFinalBody: turn.hasConfirmedFinalBody,
        }),
      };
    };

    expect(expansionForState(liveState)).toEqual({
      completionDisposition: 'active',
      hasConfirmedFinalBody: false,
      expanded: true,
    });

    const settled = materializeSessionSnapshots(
      liveState,
      sessionID,
      [{
        info: { ...liveAssistant, finish: 'stop', time: { created: 2, completed: 9 } } as Message,
        parts: [answer],
      }],
    );

    expect(expansionForState({
      message: settled.message,
      part: settled.part,
    })).toEqual({
      completionDisposition: 'normal',
      hasConfirmedFinalBody: true,
      expanded: false,
    });
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

  test('7b. the Activity host and segment id never move while a multi-step turn runs', () => {
    // User observation: the fold's content disappeared and came back. The segment
    // id used to embed "first assistant that currently has activity", so a single
    // empty-parts frame moved the anchor to the next assistant — changing both the
    // React key and the owning ChatMessage, which unmounts the whole nested fold.
    const step = (id: string, parts: Part[]): ChatMessageEntry => ({
      info: { id, role: 'assistant', sessionID, parentID: 'u1', time: { created: 2 } } as Message,
      parts,
    });

    const project = (assistantMessages: ChatMessageEntry[]) =>
      projectTurnActivity({
        turnId: 'u1',
        assistantMessages,
        showTextJustificationActivity: true,
      }).activitySegments[0];

    // Frame 1: only the second step has landed a tool.
    const frameOne = project([step('a1', []), step('a2', [toolPart('t1', 'a2', 'bash', 'running')])]);
    // Frame 2: the first step's reasoning arrives, which used to steal the anchor.
    const frameTwo = project([
      step('a1', [textPart('p1', 'a1', 'thinking')]),
      step('a2', [toolPart('t1', 'a2', 'bash', 'completed')]),
    ]);

    expect(frameOne?.id).toBe('u1:activity');
    expect(frameTwo?.id).toBe(frameOne?.id);
    expect(frameTwo?.anchorMessageId).toBe(frameOne?.anchorMessageId);
    expect(frameOne?.anchorMessageId).toBe('a1');
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
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'MessageList.tsx'),
      'utf8',
    );
    expect(source).not.toContain('hasTrailingStreamingEntries ? (');
    expect(source).toContain('<StreamingTailContent');
  });
});
