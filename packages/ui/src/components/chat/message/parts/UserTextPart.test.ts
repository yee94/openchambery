import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareUserMarkdownContent, SKILL_TOKEN_PATTERN } from './userTextPartContent';

const __dirname = dirname(fileURLToPath(import.meta.url));
const messageBodySource = readFileSync(join(__dirname, '../MessageBody.tsx'), 'utf-8');

describe('mobile primary subtask prompt', () => {
    test('omits the collapsible prompt disclosure from the primary chat surface', () => {
        expect(messageBodySource).toContain(
            "const showPromptDisclosure = Boolean(prompt) && !(isMobile && sessionSurface.kind === 'primary');"
        );
        expect(messageBodySource).toContain('{showPromptDisclosure ? (');
    });
});

describe('prepareUserMarkdownContent', () => {
    test('keeps fenced code < and -> unescaped for the markdown renderer', () => {
        const content = prepareUserMarkdownContent({
            textContent: '```rust\nlet values: Vec<i32> = vec![];\nlet next = old -> new;\n```',
            skillNames: new Set(),
        });

        expect(content).toContain('Vec<i32>');
        expect(content).toContain('old -> new');
        expect(content).not.toContain('&lt;');
        expect(content).not.toContain('-&gt;');
    });

    test('escapes raw HTML outside fences so tags display as text', () => {
        const content = prepareUserMarkdownContent({
            textContent: 'Use <b>bold</b> and <script>alert("x")</script>',
            skillNames: new Set(),
        });

        expect(content).toContain('&lt;b&gt;bold&lt;/b&gt;');
        expect(content).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
        expect(content).not.toContain('<b>bold</b>');
        expect(content).not.toContain('<script>');
    });

    test('adds hard line breaks outside fences but not inside', () => {
        const content = prepareUserMarkdownContent({
            textContent: 'first\nsecond\n```ts\nconst x = 1\nconst y = 2\n```\nthird',
            skillNames: new Set(),
        });

        expect(content).toContain('first  \nsecond  \n```ts\n');
        expect(content).toContain('const x = 1\nconst y = 2\n```  \nthird');
        expect(content).not.toContain('const x = 1  \nconst y = 2');
    });

    test('preserves mention conversion', () => {
        const content = prepareUserMarkdownContent({
            textContent: '@agent hello\n/skill-name',
            agentMention: { name: 'build-agent', token: '@agent' },
            skillNames: new Set(['skill-name']),
        });

        expect(content).toContain('[@agent](#openchamber-agent:build-agent)');
        expect(content).toContain('[/skill-name](#openchamber-skill:skill-name)');
        expect(content).toContain('hello  \n[/skill-name]');
    });

    test('can skip inline reference rewriting when chips own presentation', () => {
        const content = prepareUserMarkdownContent({
            textContent: '@agent hello\n/skill-name',
            agentMention: { name: 'build-agent', token: '@agent' },
            skillNames: new Set(['skill-name']),
            decorateInlineReferences: false,
        });

        expect(content).toContain('@agent hello  \n/skill-name');
        expect(content).not.toContain('#openchamber-agent:');
        expect(content).not.toContain('#openchamber-skill:');
    });
});

describe('SKILL_TOKEN_PATTERN', () => {
    test('recognizes standalone slash skill tokens', () => {
        SKILL_TOKEN_PATTERN.lastIndex = 0;
        expect(SKILL_TOKEN_PATTERN.test('Use /code-review for this change')).toBe(true);
        SKILL_TOKEN_PATTERN.lastIndex = 0;
        expect(SKILL_TOKEN_PATTERN.test('https://example.com/skills')).toBe(false);
    });
});

describe('SKILL_TOKEN_PATTERN', () => {
    test('recognizes standalone slash skill tokens', () => {
        SKILL_TOKEN_PATTERN.lastIndex = 0;
        expect(SKILL_TOKEN_PATTERN.test('Use /code-review for this change')).toBe(true);
        SKILL_TOKEN_PATTERN.lastIndex = 0;
        expect(SKILL_TOKEN_PATTERN.test('https://example.com/skills')).toBe(false);
    });
});
