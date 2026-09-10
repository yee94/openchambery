import { describe, expect, test } from 'vitest'
import type { AssistantContactMessage, AssistantContactPage } from './assistantDTO'
import {
  applyContactGapPage,
  applyContactLatestPage,
  applyContactOlderPage,
  CONTACT_GAP_FILL_MAX_PAGES,
  CONTACT_MESSAGES_PAGE_DEFAULT,
  emptyContactMessagesView,
  isContactMessagesInitialized,
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

  test('latest refresh keeps older history and prefers incoming on same id', () => {
    const first = applyContactLatestPage(null, page(Array.from({ length: 20 }, (_, i) => msg(i + 1)), {
      nextCursor: 'c1',
      complete: false,
      revision: 1,
    }))
    expect(first.messages).toHaveLength(20)
    expect(first.olderCursor).toBe('c1')
    expect(first.olderComplete).toBe(false)

    const refreshed = applyContactLatestPage(first, page(
      [...Array.from({ length: 10 }, (_, i) => msg(i + 11)), ...Array.from({ length: 10 }, (_, i) => msg(i + 21))],
      { nextCursor: 'c2', complete: false, revision: 2 },
    ))
    expect(refreshed.messages.map((m) => m.ordinal)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1))
    expect(refreshed.revision).toBe(2)
    expect(refreshed.hasMessageGap).toBe(false)
    expect(refreshed.olderCursor).toBe('c1')
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

  test('lower latest revision keeps same-id content but still merges unique ids', () => {
    const first = applyContactLatestPage(null, page([msg(1)], { revision: 5 }))
    const stale = applyContactLatestPage(first, page([msg(1, 'old'), msg(2)], { revision: 4 }))
    expect(stale.messages.find((m) => m.ordinal === 1)?.text).toBe('m1')
    expect(stale.messages.find((m) => m.ordinal === 2)?.text).toBe('m2')
    expect(stale.revision).toBe(5)
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
})
