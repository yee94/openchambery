import { test } from 'vitest'
import { runIndexedDbEvidence as runInputDraft } from './test-input-draft-indexeddb.mjs'
import { runIndexedDbEvidence as runTranscript } from './test-transcript-durable-indexeddb.mjs'

test('input draft indexeddb', { timeout: 120_000 }, async () => { await runInputDraft() })
test('transcript durable indexeddb', { timeout: 120_000 }, async () => { await runTranscript() })
