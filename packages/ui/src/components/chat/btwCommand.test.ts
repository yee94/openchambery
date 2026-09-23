import { beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { submitBtwCommand } from './btwCommand';
import { getLocalChatCommand, consumesImmediateCommandText, preservesComposerResources } from './localCommandClassifier';
import { shouldSubmitCommandOnSelection } from './commandSelection';

const api = vi.hoisted(() => ({ generateSessionAside: vi.fn(), sendMessage: vi.fn(), sendCommand: vi.fn() }));
vi.mock('@/lib/opencode/client', () => ({ opencodeClient: { ...api, applySendSelection: vi.fn(async () => {}) } }));
vi.mock('@/stores/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ currentProviderId: '', currentModelId: '', currentAgentName: undefined, currentVariant: null }) },
}));
vi.mock('@/sync/selection-store', () => ({
  useSelectionStore: { getState: () => ({ getSessionModelSelection: () => null, getSessionAgentSelection: () => null }) },
}));
import { useSessionBtwStore, getSessionBtwKey, resetSessionBtwStoreForRuntimeSwitch } from '@/stores/useSessionBtwStore';

const scope = { sessionId: 'session-a', directory: '/repo' };
const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ChatInput.tsx'), 'utf8');
const options = () => ({ text: '/btw Why?', inputMode: 'normal' as const, scope, allowed: true, hasReferences: false,
  ask: useSessionBtwStore.getState().ask, open: vi.fn(), clearText: vi.fn(), notify: vi.fn() });

beforeEach(() => { resetSessionBtwStoreForRuntimeSwitch(); vi.clearAllMocks(); api.generateSessionAside.mockResolvedValue({ text: 'Because.' }); });

describe('/btw composer contract', () => {
  test('is discoverable locally and selection keeps an argument draft', () => {
    expect(getLocalChatCommand('/btw why', 'normal')).toBe('btw');
    expect(getLocalChatCommand('/\u2003BTW why', 'normal')).toBe('btw');
    expect(getLocalChatCommand('/btw why', 'shell')).toBeNull();
    expect(consumesImmediateCommandText('/btw', 'normal')).toBe(false);
    expect(preservesComposerResources('/btw why', 'normal')).toBe(true);
    expect(shouldSubmitCommandOnSelection({ name: 'btw', source: 'openchamber', isBuiltIn: true }, true)).toBe(true);
    const autocomplete = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'CommandAutocomplete.tsx'), 'utf8');
    expect(autocomplete).toContain("id: 'openchamber:btw'");
  });

  test.each(['/btw', '/BTW  ', '/\u2003btw\n'])('bare %s only opens the side conversation', (text) => {
    const input = { ...options(), text };
    expect(submitBtwCommand(input)).toBe(true);
    expect(input.notify).not.toHaveBeenCalled();
    expect(input.clearText).toHaveBeenCalledOnce();
    expect(input.open).toHaveBeenCalledOnce();
    expect(api.generateSessionAside).not.toHaveBeenCalled();
    expect(useSessionBtwStore.getState().entries).toEqual({});
  });

  test('requires a session and preserves reference-bearing documents', () => {
    const missing = { ...options(), scope: null };
    submitBtwCommand(missing);
    expect(missing.notify).toHaveBeenCalledWith('sessionRequired');
    const referenced = { ...options(), hasReferences: true };
    submitBtwCommand(referenced);
    expect(referenced.notify).toHaveBeenCalledWith('plainTextRequired');
    expect(referenced.clearText).not.toHaveBeenCalled();
    expect(api.generateSessionAside).not.toHaveBeenCalled();
  });

  test('generates independently and clears only accepted text', async () => {
    const input = options();
    submitBtwCommand(input);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.generateSessionAside).toHaveBeenCalledWith(expect.objectContaining({ ...scope, prompt: expect.stringContaining('Why?'), signal: expect.any(AbortSignal) }));
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.sendCommand).not.toHaveBeenCalled();
    expect(input.clearText).toHaveBeenCalledOnce();
    expect(input.open).toHaveBeenCalledOnce();
    expect(useSessionBtwStore.getState().entries[getSessionBtwKey(scope)].turns[0]?.answer).toBe('Because.');
  });

  test('all production submit entrances claim btw before busy/flight/queue and transcript work', () => {
    const submit = source.slice(source.indexOf('const handleSubmit = async'), source.indexOf('// Update ref with latest handleSubmit'));
    const claim = submit.indexOf('submitBtwCommand(');
    for (const guard of ['claimedByEstablishingFollowUp()', 'isSubmissionInFlight()', 'captureSubmission()', 'queueMessageFromEvent()', 'shouldOptimisticPrimarySend(']) {
      expect(claim).toBeLessThan(submit.indexOf(guard));
    }
    const primary = source.slice(source.indexOf('const handlePrimaryAction ='), source.indexOf('// Draft welcome presets:'));
    expect(primary.indexOf("=== 'btw'")).toBeLessThan(primary.indexOf('isSubmissionInFlight()'));
    const enter = source.slice(source.indexOf("if (e.key === 'Enter' && !e.shiftKey)"));
    expect(enter.indexOf("=== 'btw'")).toBeLessThan(enter.indexOf('claimedByEstablishingFollowUp()'));
    expect(source).toContain('const canAbort = !isBtwCommand &&');
    expect(source).toContain('composerSendPhase(isBtwCommand ? null : submissionFlightKind');
  });
});
