import { describe, expect, test } from 'bun:test';
import { COMPOSER_REFERENCE_LIMITS, decorateComposerReference, insertComposerReference, isValidComposerSessionId, materializeComposerDocument, materializeComposerReferenceTokens, materializeSessionMentionTokens, mergeComposerRecovery, normalizeComposerReferenceDeletionWhitespace, reconcileComposerDocument, resolveComposerReferenceDeletion, serializeComposerDocument, validateComposerDocument, type ComposerDocument } from './document';
import { contributeComposerReferenceCanonical, diffComposerResources } from './extensions';
import { COMPOSER_TRIGGER_ICON_SLOT, composerTriggerIconDisplay } from './inline-visual';
import { compileComposerSendPlan } from './send-plan';

const session = (id: string, start: number, display = '@Same') => ({ id, kind: 'session' as const, sessionId: id, display, start, end: start + display.length });
const paste = (id: string, start: number, display = '[Paste 1]') => ({ id, kind: 'paste' as const, text: 'original paste', characterCount: 14, index: 1, display, start, end: start + display.length });
const sessionTriggerDisplay = (label: string) => composerTriggerIconDisplay({ trigger: '@', icon: 'chat-thread', label });
const slashTriggerDisplay = (name: string, icon = 'book-open') => composerTriggerIconDisplay({ trigger: '/', icon, label: name });
const skill = (id: string, start: number, skillName = 'review') => {
    const display = slashTriggerDisplay(skillName);
    return { id, kind: 'skill' as const, skillName, display, start, end: start + display.length };
};
const command = (id: string, start: number, commandName = 'run', reference = 'run') => {
    const display = slashTriggerDisplay(commandName);
    return { id, kind: 'command' as const, commandName, reference, display, start, end: start + display.length };
};

describe('composerReferences', () => {
    test('validates static adapter payloads and bounded session IDs', () => {
        expect(isValidComposerSessionId('ses_123-A')).toBe(true);
        for (const id of ['has:colon', 'has space', 'a\n', '', 'a'.repeat(COMPOSER_REFERENCE_LIMITS.sessionIdLength + 1)]) expect(isValidComposerSessionId(id)).toBe(false);
        expect(validateComposerDocument('@A', [{ ...session('s', 0, '@A'), kind: 'image' }]).document.references).toEqual([]);
    });

    test('counts every rejected reference and fails serialization rather than cleaning invalid sidecars', () => {
        const malformed = [{ kind: 'session' }, session('same', 0, '@A'), session('same', 3, '@B'), session('overlap', 2, 'A @')];
        const validation = validateComposerDocument('@A @B', malformed);
        expect(validation.rejectedIds).toEqual(['overlap', 'same']);
        expect(validation.rejectedCount).toBe(3);
        expect(validation.budgetExceeded).toBe(false);
        expect(validation.document.references).toEqual([session('same', 0, '@A')]);
        expect(serializeComposerDocument({ text: '@A @B', references: malformed as ComposerDocument['references'] })).toEqual({ ok: false, reason: 'invalid-references' });
        const overBudget = Array.from({ length: COMPOSER_REFERENCE_LIMITS.referenceCount + 1 }, (_, index) => session(`s${index}`, 0, '@A'));
        const budgetValidation = validateComposerDocument('@A', overBudget);
        expect(budgetValidation.rejectedCount).toBe(COMPOSER_REFERENCE_LIMITS.referenceCount);
        expect(budgetValidation.budgetExceeded).toBe(true);
        expect(serializeComposerDocument({ text: '@A', references: overBudget })).toEqual({ ok: false, reason: 'reference-budget-exceeded' });
    });

    test('normalizes browser replacement, cut, autocorrect, IME, and multi-reference edits atomically', () => {
        const document: ComposerDocument = { text: 'x @A y [Paste 1] z', references: [session('s', 2, '@A'), paste('p', 7)] };
        const backspace = reconcileComposerDocument(document, 'x @ y [Paste 1] z', 3);
        expect(backspace.document).toEqual({ text: 'x  y [Paste 1] z', references: [paste('p', 5)] });
        expect(backspace.caret).toBe(2);
        expect(reconcileComposerDocument(document, 'x  y [Paste 1] z', 2).document).toEqual(backspace.document);
        expect(reconcileComposerDocument(document, 'x auto y [Paste 1] z', 6).document.text).toBe('x auto y [Paste 1] z');
        expect(reconcileComposerDocument(document, 'x 😀 y [Paste 1] z', 4).caret).toBe(4);
        expect(reconcileComposerDocument(document, 'x replace z', 9).document).toEqual({ text: 'x replace z', references: [] });
    });

    test('requests DOM text correction only when Session or Paste atomic ranges expand the browser edit', () => {
        const plainSnapshots = ['这一把', '这一把这一版处理完', '这一把这一版处理完之后'];
        let previous = '';
        for (const snapshot of plainSnapshots) {
            const reconciled = reconcileComposerDocument({ text: previous, references: [] }, snapshot, snapshot.length);
            expect(reconciled.requiresTextCorrection).toBe(false);
            previous = snapshot;
        }

        const document: ComposerDocument = { text: '@A [Paste 1]', references: [session('s', 0, '@A'), paste('p', 3)] };
        expect(reconcileComposerDocument(document, '@XA [Paste 1]', 2).requiresTextCorrection).toBe(true);
        expect(reconcileComposerDocument(document, '@A [Paste X1]', 11).requiresTextCorrection).toBe(true);
        expect(reconcileComposerDocument(document, 'ok @A [Paste 1]', 2).requiresTextCorrection).toBe(false);
        expect(reconcileComposerDocument(document, ' [Paste 1]', 0).requiresTextCorrection).toBe(false);
    });

    test('reports insertion edits across selection expansion and inline boundaries', () => {
        const document: ComposerDocument = { text: 'left @A right', references: [session('s', 5, '@A')] };
        const inserted = insertComposerReference(document, 6, 6, paste('p', 0, '[Paste 1]'), { inlineBoundaries: true });
        expect(inserted.edit).toEqual({ oldStart: 5, oldEnd: 7, newEnd: 14 });
        expect(inserted.document).toEqual({ text: 'left [Paste 1] right', references: [paste('p', 5)] });
    });

    test('maps moved Backspace, Delete, cut, and IME carets through atomic normalization', () => {
        const document: ComposerDocument = { text: '😀 @A z', references: [session('s', 3, '@A')] };
        const backspace = reconcileComposerDocument(document, '😀 @ z', 4);
        const deleteForward = reconcileComposerDocument(document, '😀 A z', 3);
        const cut = reconcileComposerDocument(document, '😀  z', 3, 3);
        const ime = reconcileComposerDocument(document, '😀 @語A z', 5);
        expect(backspace.document).toEqual({ text: '😀  z', references: [] });
        expect([backspace.selectionStart, backspace.selectionEnd, backspace.caret]).toEqual([3, 3, 3]);
        expect(deleteForward.document).toEqual({ text: '😀  z', references: [] });
        expect(deleteForward.caret).toBe(3);
        expect(cut.document).toEqual({ text: '😀  z', references: [] });
        expect(cut.caret).toBe(3);
        expect(ime.document).toEqual({ text: '😀 語 z', references: [] });
        expect(ime.caret).toBe(4);
        expect(ime.mapCaret(-10)).toBe(0);
        expect(ime.mapCaret(10_000)).toBe(ime.document.text.length);
    });

    test('keeps boundary insertion and replaces whole references for internal insertion or partial selection', () => {
        const document: ComposerDocument = { text: '😀 @A!', references: [session('s', 3, '@A')] };
        expect(reconcileComposerDocument(document, '😀 X@A!', 4).document.references).toEqual([session('s', 4, '@A')]);
        expect(reconcileComposerDocument(document, '😀 @XA!', 5).document).toEqual({ text: '😀 X!', references: [] });
        expect(insertComposerReference(document, 4, 4, paste('p', 0)).document).toEqual({ text: '😀 [Paste 1]!', references: [paste('p', 3)] });
        expect(insertComposerReference(document, 3, 4, paste('p', 0)).document.text).toBe('😀 [Paste 1]!');
    });

    test('resolves mobile Backspace and Delete as whole reference deletions', () => {
        const document: ComposerDocument = { text: 'a @A [Paste 1] z', references: [session('s', 2, '@A'), paste('p', 5)] };
        expect(resolveComposerReferenceDeletion(document, { key: 'Backspace', selectionStart: 3, selectionEnd: 3 })?.document.text).toBe('a  [Paste 1] z');
        expect(resolveComposerReferenceDeletion(document, { key: 'Delete', selectionStart: 6, selectionEnd: 6 })?.removedIds).toEqual(['p']);
        expect(resolveComposerReferenceDeletion(document, { key: 'Backspace', selectionStart: 3, selectionEnd: 3 })?.edit).toEqual({ oldStart: 2, oldEnd: 4, newEnd: 2 });
    });

    test('atomically deletes slot-reserved references from a partial selection', () => {
        const display = sessionTriggerDisplay('Current');
        const start = 'before '.length;
        const document: ComposerDocument = {
            text: `before ${display} after`,
            references: [session('session', start, display)],
        };
        const deleted = resolveComposerReferenceDeletion(document, {
            key: 'Delete',
            selectionStart: start + 1,
            selectionEnd: start + 2,
        });

        expect(deleted?.document).toEqual({ text: 'before  after', references: [] });
        expect(deleted?.removedIds).toEqual(['session']);
        expect(deleted?.caret).toBe(start);
        expect(normalizeComposerReferenceDeletionWhitespace(deleted?.document.text ?? '', deleted?.caret ?? 0)).toEqual({ text: 'before after', caret: start });
    });

    test('reports reconciled removals for resource ownership', () => {
        const reconciled = reconcileComposerDocument({ text: '@A text', references: [session('s', 0, '@A')] }, '@ text', 1);
        expect(reconciled.removedReferences).toEqual([session('s', 0, '@A')]);
    });

    test('serializes and materializes session IDs symmetrically', () => {
        const document = materializeSessionMentionTokens('@session:a @session:b', new Map([['a', '😀'], ['b', 'B']]));
        const serialized = serializeComposerDocument(document);
        const direct = serializeComposerDocument(document, 'direct-send-display');
        expect(serialized.ok && serialized.text).toBe('@session:a @session:b');
        expect(direct.ok && direct.text).toBe('@😀 @B');
        if (!serialized.ok) throw new Error('Expected canonical serialization to succeed');
        expect(materializeComposerReferenceTokens(serialized.text, new Map([['a', '😀'], ['b', 'B']]))).toEqual(document);
    });

    test('serializes, materializes, and atomically deletes durable skill and command references', () => {
        const document: ComposerDocument = { text: `${slashTriggerDisplay('review')} ${slashTriggerDisplay('run')}`, references: [skill('skill', 0), command('command', slashTriggerDisplay('review').length + 1)] };
        const canonical = serializeComposerDocument(document);
        const direct = serializeComposerDocument(document, 'direct-send-display');
        expect(canonical.ok && [canonical.text, canonical.semantics]).toEqual(['[skill:review] [command:run]', []]);
        expect(direct.ok && [direct.text, direct.semantics]).toEqual(['[skill:review] [command:run]', []]);
        const materialized = materializeComposerReferenceTokens('[skill:review] [command:run]', new Map());
        expect(materialized).toEqual({ text: `${slashTriggerDisplay('review')} ${slashTriggerDisplay('run')}`, references: [skill('skill:0', 0), command('command:15', slashTriggerDisplay('review').length + 1)] });
        const rematerialized = serializeComposerDocument(materialized);
        expect(rematerialized.ok && rematerialized.text).toBe('[skill:review] [command:run]');
        expect(resolveComposerReferenceDeletion(document, { key: 'Backspace', selectionStart: 3, selectionEnd: 3 })?.document).toEqual({ text: ` ${slashTriggerDisplay('run')}`, references: [command('command', 1)] });
    });

    test('materializes command file references using their basename while preserving the reference', () => {
        expect(materializeComposerReferenceTokens('[command:/abs/path/review.md] [command:C:\\commands\\review.md] [command:name]', new Map())).toEqual({
            text: `${slashTriggerDisplay('review')} ${slashTriggerDisplay('review')} ${slashTriggerDisplay('name')}`,
            references: [
                command('command:0', 0, 'review', '/abs/path/review.md'),
                command('command:30', slashTriggerDisplay('review').length + 1, 'review', 'C:\\commands\\review.md'),
                command('command:62', (slashTriggerDisplay('review').length + 1) * 2, 'name', 'name'),
            ],
        });
    });

    test('rejects malformed durable skill and command references', () => {
        expect(validateComposerDocument('/review', [{ ...skill('skill', 0), skillName: 'bad skill' }]).rejectedCount).toBe(1);
        expect(validateComposerDocument('/run', [{ ...command('command', 0), reference: '' }]).rejectedCount).toBe(1);
        expect(validateComposerDocument('/run', [{ ...command('command', 0), reference: 'x'.repeat(COMPOSER_REFERENCE_LIMITS.commandReferenceLength + 1) }]).rejectedCount).toBe(1);
        expect(validateComposerDocument('/run', [{ ...command('command', 0), commandName: 'bad name' }]).rejectedCount).toBe(1);
        expect(validateComposerDocument('/run', [{ ...command('command', 0), commandName: 'bad[name' }]).rejectedCount).toBe(1);
        expect(validateComposerDocument('/run', [{ ...command('command', 0), reference: 'bad]reference' }]).rejectedCount).toBe(1);
        expect(validateComposerDocument('/run', [{ ...command('command', 0), reference: 'bad\r\nreference' }]).rejectedCount).toBe(1);
        expect(validateComposerDocument(slashTriggerDisplay('命令.v1/a_b-c'), [command('command', 0, '命令.v1/a_b-c')]).rejectedCount).toBe(0);
        expect(materializeComposerReferenceTokens('[skill:bad skill] [command:] [command:bad\r\nreference]', new Map())).toEqual({ text: '[skill:bad skill] [command:] [command:bad\r\nreference]', references: [] });
    });

    test('materializes static canonical codecs in source order and leaves overlapping token text intact', () => {
        expect(materializeComposerReferenceTokens('@session:a @session:b', new Map([['a', 'A'], ['b', 'B']]))).toEqual({ text: `${sessionTriggerDisplay('A')} ${sessionTriggerDisplay('B')}`, references: [
            { id: 'session:a:0', kind: 'session', sessionId: 'a', display: sessionTriggerDisplay('A'), start: 0, end: sessionTriggerDisplay('A').length },
            { id: 'session:b:11', kind: 'session', sessionId: 'b', display: sessionTriggerDisplay('B'), start: sessionTriggerDisplay('A').length + 1, end: sessionTriggerDisplay('A').length + sessionTriggerDisplay('B').length + 1 },
        ] });
        expect(materializeComposerReferenceTokens('@session:a@session:b', new Map([['a', 'A'], ['b', 'B']]))).toEqual({ text: '@session:a@session:b', references: [] });
    });

    test('restores v2 sidecars and materializes disjoint canonical queue tokens with rebased ranges', () => {
        const restored = materializeComposerDocument({
            text: '[Paste 1] @session:next',
            references: [paste('p', 0)],
        }, new Map([['next', 'Next']])) ;
        expect(restored).toEqual({ text: `[Paste 1] ${sessionTriggerDisplay('Next')}`, references: [
            paste('p', 0),
            { id: 'session:next:10', kind: 'session', sessionId: 'next', display: sessionTriggerDisplay('Next'), start: 10, end: 10 + sessionTriggerDisplay('Next').length },
        ] });
        expect(materializeComposerDocument({ text: '@session:current', references: [paste('p', 0, '@session:current')] }, new Map([['current', 'Current']]))).toEqual({
            text: '@session:current', references: [paste('p', 0, '@session:current')],
        });
    });

    test('adds ordinary-text boundaries while keeping the range and caret on the display', () => {
        const reference = paste('p', 0);
        expect(insertComposerReference({ text: 'left', references: [] }, 0, 0, reference, { inlineBoundaries: true }).document.text).toBe('[Paste 1] left');
        expect(insertComposerReference({ text: 'left', references: [] }, 0, 0, reference, { inlineBoundaries: true }).caret).toBe(9);
        expect(insertComposerReference({ text: 'left right', references: [] }, 5, 5, reference, { inlineBoundaries: true }).document.text).toBe('left [Paste 1] right');
        expect(insertComposerReference({ text: 'left right', references: [] }, 5, 5, reference, { inlineBoundaries: true }).caret).toBe(14);
        expect(insertComposerReference({ text: 'left', references: [] }, 4, 4, reference, { inlineBoundaries: true }).document.text).toBe('left [Paste 1]');
        const adjacent: ComposerDocument = { text: '@A [Paste 1]', references: [session('s', 0, '@A'), paste('old', 3)] };
        expect(insertComposerReference(adjacent, 3, 3, reference, { inlineBoundaries: true }).document.text).toBe('@A [Paste 1] [Paste 1]');
    });

    test('pads document edges when chip insertion requests edge spaces', () => {
        const reference = skill('skill', 0, 'review');
        expect(insertComposerReference({ text: '', references: [] }, 0, 0, reference, {
            inlineBoundaries: true,
            padDocumentEdges: true,
        }).document.text).toBe(` ${slashTriggerDisplay('review')} `);
        expect(insertComposerReference({ text: 'after', references: [] }, 0, 0, reference, {
            inlineBoundaries: true,
            padDocumentEdges: true,
        }).document.text).toBe(` ${slashTriggerDisplay('review')} after`);
        expect(insertComposerReference({ text: 'before', references: [] }, 6, 6, reference, {
            inlineBoundaries: true,
            padDocumentEdges: true,
        }).document.text).toBe(`before ${slashTriggerDisplay('review')} `);
    });

    test('round-trips adjacent session and paste references with ordinary spacing', () => {
        const sessionThenPaste = insertComposerReference({ text: '@A', references: [session('s', 0, '@A')] }, 2, 2, paste('p', 0), { inlineBoundaries: true }).document;
        const pasteThenSession = insertComposerReference({ text: '[Paste 1]', references: [paste('p', 0)] }, 9, 9, session('s', 0, '@A'), { inlineBoundaries: true }).document;
        const sessionThenSession = insertComposerReference({ text: '@A', references: [session('a', 0, '@A')] }, 2, 2, session('b', 0, '@B'), { inlineBoundaries: true }).document;
        expect(sessionThenPaste.text).toBe('@A [Paste 1]');
        expect(pasteThenSession.text).toBe('[Paste 1] @A');
        expect(sessionThenSession.text).toBe('@A @B');
        for (const document of [sessionThenPaste, pasteThenSession, sessionThenSession]) {
            expect(materializeComposerDocument(document, new Map([['s', 'A'], ['a', 'A'], ['b', 'B']]))).toEqual(document);
        }
    });

    test('keeps oversized cumulative paste payload as raw input', () => {
        const payload = 'x'.repeat(COMPOSER_REFERENCE_LIMITS.pastePayloadLength);
        const document: ComposerDocument = { text: '[1][2][3]', references: [
            { ...paste('p1', 0, '[1]'), text: payload, characterCount: payload.length },
            { ...paste('p2', 3, '[2]'), text: payload, characterCount: payload.length, index: 2 },
            { ...paste('p3', 6, '[3]'), text: 'x', characterCount: 1, index: 3 },
        ] };
        expect(validateComposerDocument(document.text, document.references).payloadBudgetExceeded).toBe(true);
        expect(serializeComposerDocument(document)).toEqual({ ok: false, reason: 'reference-payload-budget-exceeded' });
    });

    test('preserves canonical text when the shared candidate budget overflows', () => {
        const text = Array.from({ length: COMPOSER_REFERENCE_LIMITS.referenceCount + 1 }, () => '@session:a').join(' ');
        expect(materializeComposerReferenceTokens(text, new Map([['a', 'A']]))).toEqual({ text, references: [] });
    });

    test('returns explicit serialization failures without dropping references', () => {
        expect(serializeComposerDocument({ text: 'x'.repeat(COMPOSER_REFERENCE_LIMITS.canonicalOutputLength + 1), references: [] })).toEqual({ ok: false, reason: 'canonical-output-too-large' });
    });

    test('preserves text beyond visible budgets and independently valid v2 references', () => {
        const text = `@A${'x'.repeat(COMPOSER_REFERENCE_LIMITS.visibleTextLength)}`;
        expect(validateComposerDocument(text, [session('good', 0, '@A')]).document).toEqual({ text, references: [session('good', 0, '@A')] });
        expect(materializeComposerReferenceTokens(`@session:a${'x'.repeat(COMPOSER_REFERENCE_LIMITS.visibleTextLength)}`, new Map([['a', 'A']]))).toEqual({ text: `@session:a${'x'.repeat(COMPOSER_REFERENCE_LIMITS.visibleTextLength)}`, references: [] });
    });

    test('collapses browser remnants around atomic replacements and clamps IME selections', () => {
        const document: ComposerDocument = { text: '@ABC', references: [session('s', 0, '@ABC')] };
        const deletion = reconcileComposerDocument(document, '@AC', 1, 3);
        expect(deletion.document).toEqual({ text: '', references: [] });
        expect([deletion.selectionStart, deletion.selectionEnd]).toEqual([0, 0]);
        const ime = reconcileComposerDocument(document, '@A語C', 2, 3);
        expect(ime.document.text).toBe('語');
        expect([ime.selectionStart, ime.selectionEnd]).toEqual([0, 1]);
    });


    test('restores failed text first with stable ids, default separation, and idempotency', () => {
        const failed: ComposerDocument = { text: '@A', references: [session('same', 0, '@A')] };
        const current: ComposerDocument = { text: '[Paste 1] [Paste 1]', references: [paste('same', 0), paste('recovered:same', 10)] };
        const merged = mergeComposerRecovery(failed, current);
        expect(merged.text).toBe('@A\n\n[Paste 1] [Paste 1]');
        expect(merged.references.map((reference) => reference.id)).toEqual(['same', 'recovered:same', 'recovered:recovered:same']);
        expect(mergeComposerRecovery(merged, merged)).toEqual(merged);
    });

    test('compiles direct-send provenance and only Session references contribute semantics', () => {
        const document: ComposerDocument = {
            text: 'before @Same middle [Paste 1] after',
            references: [session('session-a', 7), { ...paste('paste', 20), text: '@session:x /skill', characterCount: 17 }],
        };
        const compiled = compileComposerSendPlan(document, 'direct-send-display');
        expect(compiled).toEqual({ ok: true, text: 'before @Same middle @session:x /skill after', plan: {
            chunks: [
                { provenance: 'authored', text: 'before ', start: 0, end: 7 },
                { provenance: 'generated-reference', text: '@Same', start: 7, end: 12, referenceId: 'session-a', semantic: { type: 'session', sessionId: 'session-a' } },
                { provenance: 'authored', text: ' middle ', start: 12, end: 20 },
                { provenance: 'reference-payload', text: '@session:x /skill', start: 20, end: 29, referenceId: 'paste' },
                { provenance: 'authored', text: ' after', start: 29, end: 35 },
            ],
            semantics: [{ type: 'session', sessionId: 'session-a' }],
        } });
    });

    test('compiles queue canonical text, preserves same-title identities, and exposes decoration', () => {
        const document: ComposerDocument = { text: '@Same @Same', references: [session('first', 0), session('second', 6)] };
        const queue = compileComposerSendPlan(document);
        expect(queue.ok && [queue.text, queue.plan.semantics]).toEqual(['@session:first @session:second', [{ type: 'session', sessionId: 'first' }, { type: 'session', sessionId: 'second' }]]);
        const direct = compileComposerSendPlan(document, 'direct-send-display');
        expect(direct.ok && direct.plan.semantics).toEqual([{ type: 'session', sessionId: 'first' }, { type: 'session', sessionId: 'second' }]);
        expect(decorateComposerReference(session('first', 0))).toEqual({
            style: 'mentionSession',
            visual: { trigger: '@', icon: 'chat-thread', align: 'end', label: 'Same', slot: 'compact' },
        });
        expect(decorateComposerReference(paste('paste', 0))).toEqual({ style: 'mentionPaste' });
        expect(decorateComposerReference(skill('skill', 0))).toEqual({
            style: 'mentionCommand',
            skillName: 'review',
            visual: { trigger: `/${COMPOSER_TRIGGER_ICON_SLOT}`, icon: 'book-open', align: 'end', label: 'review', slot: 'reserved' },
        });
        expect(decorateComposerReference(command('command', 0))).toEqual({
            style: 'mentionCommand',
            visual: { trigger: `/${COMPOSER_TRIGGER_ICON_SLOT}`, icon: 'command', align: 'end', label: 'run', slot: 'reserved' },
        });
    });

    test('derives every canonical reference strategy through its extension helper', () => {
        const references = [session('s', 0, '@A'), paste('p', 3)];
        const document: ComposerDocument = { text: '@A [Paste 1]', references };
        const planned = compileComposerSendPlan(document);
        expect(planned.ok && planned.plan.chunks.filter((chunk) => chunk.provenance !== 'authored').map((chunk) => chunk.text)).toEqual(references.map((reference) => contributeComposerReferenceCanonical(reference).text));
    });

    test('deduplicates discriminated resource identities and computes deltas', () => {
        const attachment = { type: 'attachment' as const, attachmentRefID: 'attachment-a' };
        expect(diffComposerResources([attachment, attachment], [attachment, { type: 'attachment', attachmentRefID: 'attachment-b' }])).toEqual({
            previous: [attachment],
            next: [attachment, { type: 'attachment', attachmentRefID: 'attachment-b' }],
            added: [{ type: 'attachment', attachmentRefID: 'attachment-b' }],
            removed: [],
        });
    });

    test('fails send planning for malformed ranges and output budgets', () => {
        expect(compileComposerSendPlan({ text: '@A', references: [session('a', 1)] })).toEqual({ ok: false, reason: 'invalid-references' });
        expect(compileComposerSendPlan({ text: 'x'.repeat(COMPOSER_REFERENCE_LIMITS.canonicalOutputLength + 1), references: [] })).toEqual({ ok: false, reason: 'canonical-output-too-large' });
    });
});
