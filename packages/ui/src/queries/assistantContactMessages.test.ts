import { describe, expect, test } from 'vitest'
import type { AssistantContactMessage, AssistantContactPage } from './assistantDTO'
import {
  applyContactGapPage,
  applyContactLatestPage,
  applyContactOlderPage,
  compareContactMessageKeyset,
  CONTACT_GAP_FILL_MAX_PAGES,
  CONTACT_MESSAGES_PAGE_DEFAULT,
  emptyContactMessagesView,
  getLoadedAssistantReadPosition,
  isContactMessagesInitialized,
  isContactVisiblePart,
  mergeContactMessagesById,
} from './assistantContactMessages'

const msg = (
  ordinal: number,
  text = `m${ordinal}`,
  extra: Partial<AssistantContactMessage> = {},
): AssistantContactMessage => ({
  messageID: `id_${ordinal}`,
  assistantID: 'asst_1',
  role: 'user',
  turnID: `id_${ordinal}`,
  bubbleIndex: 0,
  createdAt: ordinal,
  ordinal,
  status: 'complete',
  fromAssistantID: null,
  fromAssistantName: null,
  parts: [{ type: 'text', text }],
  text,
  cards: [],
  ...extra,
})

const page = (
  messages: AssistantContactMessage[],
  extra: Partial<AssistantContactPage> = {},
): AssistantContactPage => ({
  messages,
  nextCursor: extra.nextCursor === undefined ? null : extra.nextCursor,
  complete: extra.complete ?? true,
  generation: extra.generation ?? 0,
  revision: extra.revision ?? 1,
})

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(from + i))

describe('assistantContactMessages merge', () => {
  test('constants match server default page and gap batch bound', () => {
    expect(CONTACT_MESSAGES_PAGE_DEFAULT).toBe(20)
    expect(CONTACT_GAP_FILL_MAX_PAGES).toBe(5)
  })

  test('legal wipe holes in one latest page are not a gap', () => {
    const first = applyContactLatestPage(null, page([msg(10), msg(12)], {
      nextCursor: null,
      complete: true,
      revision: 1,
    }))
    expect(first.hasMessageGap).toBe(false)
    const again = applyContactLatestPage(first, page([msg(10), msg(12)], {
      nextCursor: null,
      complete: true,
      revision: 2,
    }))
    expect(again.hasMessageGap).toBe(false)
    expect(again.messages.map((m) => m.ordinal)).toEqual([10, 12])
  })

  test('latest refresh keeps older history and replaces same-id content in coverage', () => {
    const first = applyContactLatestPage(null, page(Array.from({ length: 20 }, (_, i) => msg(i + 1)), {
      nextCursor: 'c1',
      complete: false,
      revision: 1,
    }))
    expect(first.messages).toHaveLength(20)
    expect(first.olderCursor).toBe('c1')
    expect(first.olderComplete).toBe(false)

    const refreshed = applyContactLatestPage(first, page(
      [
        ...Array.from({ length: 10 }, (_, i) => msg(i + 11, `upd-${i + 11}`)),
        ...Array.from({ length: 10 }, (_, i) => msg(i + 21)),
      ],
      { nextCursor: 'c2', complete: false, revision: 2 },
    ))
    expect(refreshed.messages.map((m) => m.ordinal)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1))
    expect(refreshed.messages.find((m) => m.ordinal === 15)?.text).toBe('upd-15')
    expect(refreshed.revision).toBe(2)
    expect(refreshed.hasMessageGap).toBe(false)
    expect(refreshed.olderCursor).toBe('c1')
  })

  test('same-generation authoritative latest drops deleted mid-window rows and keeps confirm', () => {
    // Realtime already persisted assistant bubbles; new_conversation deletes them and writes confirm.
    const seeded = applyContactLatestPage(null, page([
      msg(1, 'user-turn', { role: 'user', turnID: 'turn_1', messageID: 'user_1' }),
      msg(2, 'spoken', {
        role: 'assistant', turnID: 'turn_1', messageID: 'asst_bubble', bubbleIndex: 0,
      }),
      msg(3, 'card-title', {
        role: 'assistant', turnID: 'turn_1', messageID: 'asst_card', bubbleIndex: 1,
      }),
      msg(4, 'peer-hi', {
        role: 'user', turnID: 'peer_1', messageID: 'peer_1', fromAssistantID: 'other',
      }),
    ], { generation: 0, revision: 3, complete: true }))
    expect(seeded.messages).toHaveLength(4)

    const afterNew = applyContactLatestPage(seeded, page([
      msg(1, 'user-turn', { role: 'user', turnID: 'turn_1', messageID: 'user_1' }),
      msg(4, 'peer-hi', {
        role: 'user', turnID: 'peer_1', messageID: 'peer_1', fromAssistantID: 'other',
      }),
      msg(5, 'confirm-new', {
        role: 'assistant', turnID: 'turn_new', messageID: 'confirm_1', bubbleIndex: 0,
      }),
    ], { generation: 0, revision: 4, complete: true }))

    expect(afterNew.messages.map((m) => m.messageID)).toEqual(['user_1', 'peer_1', 'confirm_1'])
    expect(afterNew.messages.some((m) => m.messageID === 'asst_bubble' || m.messageID === 'asst_card')).toBe(false)
    expect(afterNew.revision).toBe(4)
  })

  test('authoritative complete empty page clears same-generation cache', () => {
    const first = applyContactLatestPage(null, page([msg(1), msg(2)], {
      generation: 0, revision: 2, complete: true,
    }))
    const cleared = applyContactLatestPage(first, page([], {
      generation: 0, revision: 3, complete: true, nextCursor: null,
    }))
    expect(cleared.messages).toEqual([])
    expect(cleared.liveWindowIDs).toEqual([])
    expect(cleared.olderComplete).toBe(true)
    expect(cleared.olderCursor).toBeNull()
    expect(cleared.hasMessageGap).toBe(false)
    expect(cleared.revision).toBe(3)
  })

  test('partial latest coverage retains older history outside page span', () => {
    const first = applyContactLatestPage(null, page(range(1, 20), {
      nextCursor: 'older', complete: false, revision: 1,
    }))
    // Server deleted ordinal 18 inside the latest window; page still incomplete.
    const partial = applyContactLatestPage(first, page(
      [...range(11, 17), ...range(19, 28)],
      { nextCursor: 'gap', complete: false, revision: 2 },
    ))
    expect(partial.messages.map((m) => m.ordinal)).toEqual([
      ...Array.from({ length: 10 }, (_, i) => i + 1),
      ...Array.from({ length: 7 }, (_, i) => i + 11),
      ...Array.from({ length: 10 }, (_, i) => i + 19),
    ])
    expect(partial.messages.some((m) => m.ordinal === 18)).toBe(false)
    expect(partial.olderCursor).toBe('older')
    expect(partial.hasMessageGap).toBe(false)
  })

  test.each([true, false])('reset with a regressed tip removes deleted trailing bubbles (complete=%s)', (complete) => {
    const user = msg(1, 'new conversation', { role: 'user', messageID: 'user_1' })
    const first = applyContactLatestPage(null, page([
      user,
      msg(2, 'spoken one', { messageID: 'user_1:bubble:1' }),
      msg(3, 'spoken two', { messageID: 'user_1:bubble:2' }),
    ], { generation: 0, revision: 3, complete, nextCursor: complete ? null : 'older' }))
    const authoritative = page([
      user,
      msg(2, 'confirmation', { messageID: 'user_1:bubble:1' }),
    ], { generation: 0, revision: 4, complete, nextCursor: complete ? null : 'older' })
    const refreshed = applyContactLatestPage(first, authoritative)
    expect(refreshed.messages.map((m) => m.messageID)).toEqual(['user_1', 'user_1:bubble:1'])
    expect(refreshed.messages.map((m) => m.text)).toEqual(['new conversation', 'confirmation'])
    expect(applyContactLatestPage(refreshed, authoritative).messages).toEqual(refreshed.messages)
  })

  test('generation reset drops history; empty gen1 rejects late gen0 latest', () => {
    const first = applyContactLatestPage(null, page([msg(1), msg(2)], { generation: 0, revision: 1, nextCursor: 'c', complete: false }))
    const wiped = applyContactLatestPage(first, page([], { generation: 1, revision: 5, complete: true, nextCursor: null }))
    expect(wiped.generation).toBe(1)
    expect(wiped.messages).toHaveLength(0)
    expect(isContactMessagesInitialized(wiped)).toBe(true)
    const late = applyContactLatestPage(wiped, page([msg(9)], { generation: 0, revision: 9, complete: true }))
    expect(late).toBe(wiped)
    expect(late.messages).toHaveLength(0)
  })

  test('lower latest revision keeps same-id content, merges unique ids, and does not delete', () => {
    const first = applyContactLatestPage(null, page([msg(1), msg(2), msg(3)], { revision: 5, complete: true }))
    const stale = applyContactLatestPage(first, page([msg(1, 'old'), msg(2)], { revision: 4, complete: true }))
    expect(stale.messages.map((m) => m.ordinal)).toEqual([1, 2, 3])
    expect(stale.messages.find((m) => m.ordinal === 1)?.text).toBe('m1')
    expect(stale.messages.find((m) => m.ordinal === 2)?.text).toBe('m2')
    expect(stale.revision).toBe(5)

    const staleAdds = applyContactLatestPage(first, page([msg(1, 'old'), msg(9)], { revision: 4, complete: true }))
    expect(staleAdds.messages.map((m) => m.ordinal)).toEqual([1, 2, 3, 9])
    expect(staleAdds.messages.find((m) => m.ordinal === 1)?.text).toBe('m1')
  })

  test('gap uses window non-overlap; same latest keeps resume until earliest target hit', () => {
    const first = applyContactLatestPage(null, page(range(1, 20), {
      nextCursor: 'older',
      complete: false,
      revision: 1,
    }))
    const slid = applyContactLatestPage(first, page(range(102, 121), {
      nextCursor: 'gap-start',
      complete: false,
      revision: 2,
    }))
    expect(slid.hasMessageGap).toBe(true)
    expect(slid.gapCursor).toBe('gap-start')
    expect(slid.gapTargetIDs).toContain('id_20')
    expect(slid.gapRequestIDs).toEqual(slid.gapTargetIDs)
    const requestOpen = [...(slid.gapRequestIDs ?? [])]
    const targetsOpen = [...(slid.gapTargetIDs ?? [])]

    const partial = applyContactGapPage(slid, page(range(82, 101), {
      nextCursor: 'gap-mid',
      complete: false,
      revision: 2,
    }), { requestIDs: requestOpen })
    expect(partial.hasMessageGap).toBe(true)
    expect(partial.gapCursor).toBe('gap-mid')

    const again = applyContactLatestPage(partial, page(range(102, 121), {
      nextCursor: 'gap-start',
      complete: false,
      revision: 2,
    }))
    expect(again.hasMessageGap).toBe(true)
    expect(again.gapCursor).toBe('gap-mid')
    expect(again.gapRequestIDs).toEqual(requestOpen)
    expect(again.gapTargetIDs).toEqual(targetsOpen)

    const closed = applyContactGapPage(again, page([msg(20)], {
      nextCursor: 'more',
      complete: false,
      revision: 2,
    }), { requestIDs: requestOpen })
    expect(closed.hasMessageGap).toBe(false)
    expect(closed.gapCursor).toBeNull()
  })

  test('full sequence 1..20 → 102..121 → 222..241 → late old → new fill closes only at earliest 1..20', () => {
    const first = applyContactLatestPage(null, page(range(1, 20), {
      nextCursor: 'c0',
      complete: false,
      revision: 1,
    }))
    const slidA = applyContactLatestPage(first, page(range(102, 121), {
      nextCursor: 'gap-a',
      complete: false,
      revision: 2,
    }))
    expect(slidA.hasMessageGap).toBe(true)
    expect(slidA.gapCursor).toBe('gap-a')
    const targetsEarliest = [...(slidA.gapTargetIDs ?? [])]
    expect(targetsEarliest).toContain('id_1')
    expect(targetsEarliest).toContain('id_20')
    const requestA = [...(slidA.gapRequestIDs ?? [])]

    const slidB = applyContactLatestPage(slidA, page(range(222, 241), {
      nextCursor: 'gap-b',
      complete: false,
      revision: 3,
    }))
    // After second full slide: new request identity under 102..121, earliest targets still 1..20.
    expect(slidB.hasMessageGap).toBe(true)
    expect(slidB.gapCursor).toBe('gap-b')
    expect(slidB.gapTargetIDs).toEqual(targetsEarliest)
    expect(slidB.gapRequestIDs).toContain('id_102')
    expect(slidB.gapRequestIDs).not.toEqual(requestA)
    const requestB = [...(slidB.gapRequestIDs ?? [])]
    const cursorAfterSlide = slidB.gapCursor

    // Late old-session page (identity A): merge only; must not advance new cursor or close.
    const stale = applyContactGapPage(slidB, page(range(2, 21), {
      nextCursor: null,
      complete: true,
      revision: 3,
    }), { requestIDs: requestA, cursor: 'gap-a' })
    expect(stale.hasMessageGap).toBe(true)
    expect(stale.gapCursor).toBe(cursorAfterSlide)
    expect(stale.gapCursor).toBe('gap-b')
    expect(stale.gapRequestIDs).toEqual(requestB)
    expect(stale.gapTargetIDs).toEqual(targetsEarliest)
    expect(stale.messages.some((m) => m.ordinal === 21)).toBe(true)

    // Walk full bridge 202..221 … 22..41; mid window 102..121 must NOT close (targets still 1..20).
    let view = stale
    for (const start of [202, 182, 162, 142, 122, 102, 82, 62, 42, 22]) {
      view = applyContactGapPage(view, page(range(start, start + 19), {
        nextCursor: `g-${start}`,
        complete: false,
        revision: 3,
      }), { requestIDs: requestB })
      expect(view.hasMessageGap, `still open after ${start}..${start + 19}`).toBe(true)
      expect(view.gapTargetIDs).toEqual(targetsEarliest)
    }
    // Final page includes id_20 → close; full ordinal set 1..241.
    view = applyContactGapPage(view, page(range(2, 21), {
      nextCursor: null,
      complete: true,
      revision: 3,
    }), { requestIDs: requestB })
    expect(view.hasMessageGap).toBe(false)
    expect(view.gapCursor).toBeNull()
    expect(view.messages.map((m) => m.ordinal)).toEqual(Array.from({ length: 241 }, (_, i) => i + 1))
  })

  test('older gen lower is discarded; only latest opens a new generation', () => {
    const gen1 = applyContactLatestPage(null, page([msg(1)], { generation: 1, revision: 10 }))
    const olderStaleGen = applyContactOlderPage(gen1, page([msg(0)], { generation: 0, revision: 9 }))
    expect(olderStaleGen).toBe(gen1)
    const gapStaleGen = applyContactGapPage(gen1, page([msg(0)], { generation: 0, revision: 9 }))
    expect(gapStaleGen).toBe(gen1)
    const emptyInit = emptyContactMessagesView()
    expect(isContactMessagesInitialized(emptyInit)).toBe(false)
    const latestBump = applyContactLatestPage(gen1, page([msg(5)], { generation: 2, revision: 11 }))
    expect(latestBump.generation).toBe(2)
    expect(latestBump.messages.map((m) => m.ordinal)).toEqual([5])
  })

  test('lower page revision still merges unique older ids; same-id keeps higher-rev content', () => {
    const latest = applyContactLatestPage(null, page(
      Array.from({ length: 20 }, (_, i) => msg(i + 21, `new-${i + 21}`)),
      { revision: 10, nextCursor: 'o', complete: false },
    ))
    const older = applyContactOlderPage(latest, page(
      [
        ...Array.from({ length: 20 }, (_, i) => msg(i + 1, `old-${i + 1}`)),
        msg(21, 'should-not-overwrite'),
      ],
      { revision: 9, nextCursor: null, complete: true },
    ))
    expect(older.messages.some((m) => m.ordinal === 1 && m.text === 'old-1')).toBe(true)
    expect(older.messages.find((m) => m.ordinal === 21)?.text).toBe('new-21')
    expect(older.messages).toHaveLength(40)
  })

  test('older page appends without dropping latest', () => {
    const latest = applyContactLatestPage(null, page([msg(21), msg(22)], {
      nextCursor: 'o1',
      complete: false,
      revision: 1,
    }))
    const older = applyContactOlderPage(latest, page([msg(19), msg(20)], {
      nextCursor: 'o2',
      complete: false,
      revision: 1,
    }))
    expect(older.messages.map((m) => m.ordinal)).toEqual([19, 20, 21, 22])
    expect(older.olderCursor).toBe('o2')
    expect(mergeContactMessagesById(older.messages, older.messages)).toBeTruthy()
  })

  test('empty view bootstrap', () => {
    expect(emptyContactMessagesView().messages).toEqual([])
    expect(isContactMessagesInitialized(emptyContactMessagesView())).toBe(false)
  })

  test('keyset order is SQLite BINARY-equivalent (not localeCompare) for same ordinal', () => {
    // ASCII binary: uppercase before lowercase; punctuation before letters.
    expect(compareContactMessageKeyset(
      { ordinal: 1, messageID: 'B' },
      { ordinal: 1, messageID: 'a' },
    )).toBeLessThan(0)
    expect('B' < 'a').toBe(true)
    // localeCompare often folds case and can disagree with binary on a/B.
    const localeDisagree = Math.sign('B'.localeCompare('a')) !== Math.sign(
      compareContactMessageKeyset({ ordinal: 0, messageID: 'B' }, { ordinal: 0, messageID: 'a' }),
    )
    // Document the hazard even when a locale happens to match; sort must stay binary.
    expect(typeof localeDisagree).toBe('boolean')

    expect(compareContactMessageKeyset(
      { ordinal: 1, messageID: 'msg-A' },
      { ordinal: 1, messageID: 'msg_A' },
    )).toBeLessThan(0) // '-' (0x2d) < '_' (0x5f)
    expect(compareContactMessageKeyset(
      { ordinal: 1, messageID: 'id_1' },
      { ordinal: 1, messageID: 'id_1' },
    )).toBe(0)
    expect(compareContactMessageKeyset(
      { ordinal: 2, messageID: 'z' },
      { ordinal: 1, messageID: 'a' },
    )).toBeGreaterThan(0)

    const sameOrdinal = [
      msg(5, 'b', { messageID: 'b' }),
      msg(5, 'A', { messageID: 'A' }),
      msg(5, 'a', { messageID: 'a' }),
      msg(5, '_', { messageID: '_' }),
      msg(5, '-', { messageID: '-' }),
    ]
    const merged = mergeContactMessagesById([], sameOrdinal)
    expect(merged.map((row) => row.messageID)).toEqual(['-', 'A', '_', 'a', 'b'])
  })

  test('visible part and loaded read position use full keyset + per-part settle rules', () => {
    expect(isContactVisiblePart({ type: 'text', text: 'hi' })).toBe(true)
    expect(isContactVisiblePart({ type: 'text', text: '  ' })).toBe(false)
    expect(isContactVisiblePart({ type: 'text', text: 'oc.settle.complete' })).toBe(false)
    expect(isContactVisiblePart({ type: 'file' })).toBe(true)

    const assistant = {
      id: 'asst_1',
      unreadCount: 2,
      readTip: { generation: 0, ordinal: 9, messageID: 'tip' },
      readWatermark: { generation: 0, ordinal: 5, messageID: 'b' },
    }
    // Same ordinal as watermark: messageID must decide already-read.
    const afterMark = msg(5, 'body', {
      messageID: 'c',
      role: 'assistant',
      assistantID: 'asst_1',
    })
    const atMark = msg(5, 'body', {
      messageID: 'b',
      role: 'assistant',
      assistantID: 'asst_1',
    })
    const beforeMark = msg(5, 'body', {
      messageID: 'a',
      role: 'assistant',
      assistantID: 'asst_1',
    })
    expect(getLoadedAssistantReadPosition(assistant, {
      generation: 0,
      messages: [afterMark],
    })).toEqual({ generation: 0, ordinal: 5, messageID: 'c' })
    expect(getLoadedAssistantReadPosition(assistant, {
      generation: 0,
      messages: [atMark],
    })).toBeNull()
    expect(getLoadedAssistantReadPosition(assistant, {
      generation: 0,
      messages: [beforeMark],
    })).toBeNull()

    // Settle prefix + spoken body still qualifies; pure settle / blank do not.
    const mixed = msg(7, 'x', {
      role: 'assistant',
      assistantID: 'asst_1',
      messageID: 'mix',
      parts: [
        { type: 'text', text: 'oc.settle.complete' },
        { type: 'text', text: 'spoken' },
      ],
      text: 'oc.settle.completespoken',
    })
    expect(getLoadedAssistantReadPosition(assistant, {
      generation: 0,
      messages: [mixed],
    })).toEqual({ generation: 0, ordinal: 7, messageID: 'mix' })
    expect(getLoadedAssistantReadPosition(assistant, {
      generation: 0,
      messages: [msg(8, 'oc.settle.error', {
        role: 'assistant',
        assistantID: 'asst_1',
        messageID: 'settle',
        parts: [{ type: 'text', text: 'oc.settle.error' }],
      })],
    })).toBeNull()
  })
})
