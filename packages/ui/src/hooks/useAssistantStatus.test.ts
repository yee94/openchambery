import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const statusSource = readFileSync(join(__dirname, 'useAssistantStatus.ts'), 'utf-8');

describe('useAssistantStatus compaction hint', () => {
    test('prefers compacting over leftover previous-turn tool status', () => {
        expect(statusSource).toContain('isCompactionCommandParts');
        expect(statusSource).toContain('const lastUserIsCompaction = Boolean(lastUserId) && isCompactionCommandParts(lastUserParts)');
        expect(statusSource).toContain('const preferCompactionStatus = isWorking && lastUserIsCompaction');
        expect(statusSource).toContain("t('chat.assistantStatus.compacting')");
        expect(statusSource).toContain('preferCompactionStatus ? t(\'chat.assistantStatus.compacting\') : parsedStatus.statusText');
        expect(statusSource).toContain('!preferCompactionStatus && (parsedStatus.activePartType === \'tool\' || parsedStatus.activePartType === \'editing\')');
    });

    test('confirmed final body settles the working hint immediately', () => {
        expect(statusSource).toContain('hasConfirmedFinalBody');
        expect(statusSource).toContain('if (isTurnSettled)');
        expect(statusSource).toContain('isTurnSettled: true');
        expect(statusSource).toContain('isTurnSettled: false');
    });
});
