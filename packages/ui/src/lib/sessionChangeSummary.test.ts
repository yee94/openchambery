import { describe, expect, test } from 'vitest'
import {
  formatSessionChangeCounts,
  readSessionBranchLabel,
  readSessionChangeSummary,
  readSessionModelLabel,
} from './sessionChangeSummary'

describe('sessionChangeSummary', () => {
  test('reads additions, deletions, and files from session.summary', () => {
    expect(readSessionChangeSummary({
      summary: { additions: 12, deletions: 3, files: 4 },
    })).toEqual({ additions: 12, deletions: 3, files: 4 })
  })

  test('uses diffCount as files when files is absent', () => {
    expect(readSessionChangeSummary({
      summary: { diffCount: 2, additions: 1 },
    })).toEqual({ additions: 1, files: 2 })
  })

  test('does not invent zeros for missing counts', () => {
    expect(readSessionChangeSummary({ summary: { additions: 5 } })).toEqual({ additions: 5 })
    expect(readSessionChangeSummary({ summary: {} })).toBeNull()
    expect(readSessionChangeSummary({})).toBeNull()
    expect(readSessionChangeSummary(null)).toBeNull()
  })

  test('formats +N −M from present counts only', () => {
    expect(formatSessionChangeCounts({ additions: 12, deletions: 3 })).toBe('+12 −3')
    expect(formatSessionChangeCounts({ additions: 4 })).toBe('+4')
    expect(formatSessionChangeCounts({ files: 2 })).toBeNull()
    expect(formatSessionChangeCounts(null)).toBeNull()
  })

  test('reads model and branch only when those fields exist', () => {
    expect(readSessionModelLabel({ providerID: 'opencode-go', modelID: 'deepseek-v4-flash' }))
      .toBe('opencode-go/deepseek-v4-flash')
    expect(readSessionModelLabel({ model: { providerID: 'p', modelID: 'm' } })).toBe('p/m')
    expect(readSessionModelLabel({ title: 'Login' })).toBeNull()
    expect(readSessionBranchLabel({ branch: 'feat/home' })).toBe('feat/home')
    expect(readSessionBranchLabel({ project: { branch: 'main' } })).toBe('main')
    expect(readSessionBranchLabel({ title: 'Login' })).toBeNull()
  })
})
