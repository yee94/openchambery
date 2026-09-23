import { describe, expect, it } from 'vitest';
import { skillAttachmentsFromText } from './skill-attachments';

describe('V2 skill attachments', () => {
    it('loads explicit chip ids once, preserving case and excluding commands', () => {
        expect(skillAttachmentsFromText('[skill:Review] focus [skill:release] [skill:Review] [command:run]'))
            .toEqual([{ id: 'Review', name: 'Review' }, { id: 'release', name: 'release' }]);
    });

    it('does not turn arbitrary slash text or display labels into skill ids', () => {
        expect(skillAttachmentsFromText('/unknown [skill:Git Release] ordinary text')).toEqual([]);
    });
});
