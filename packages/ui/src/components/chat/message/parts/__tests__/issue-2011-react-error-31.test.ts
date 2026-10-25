import React from 'react';
import { describe, test, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { coerceToText, renderTodoOutput } from '../../toolRenderers';

describe('coerceToText (issue #2011)', () => {
    test('returns strings unchanged', () => {
        expect(coerceToText('hello')).toBe('hello');
    });

    test('coerces plain objects to JSON strings', () => {
        // The exact shape that produced React error #31: object with {TODO} key
        const result = coerceToText({ TODO: 'Review the diff' });
        expect(typeof result).toBe('string');
        expect(result).toContain('TODO');
        expect(result).toContain('Review the diff');
    });

    test('coerces nested objects to JSON strings', () => {
        const result = coerceToText({ todos: [{ TODO: 'a' }, { content: 'b' }] });
        expect(typeof result).toBe('string');
        const parsed = JSON.parse(result);
        expect(parsed).toBeTruthy();
    });

    test('coerces numbers and booleans', () => {
        expect(coerceToText(42)).toBe('42');
        expect(coerceToText(true)).toBe('true');
        expect(coerceToText(false)).toBe('false');
    });

    test('returns fallback for null/undefined', () => {
        expect(coerceToText(null)).toBe('');
        expect(coerceToText(undefined)).toBe('');
        expect(coerceToText(null, 'oops')).toBe('oops');
    });

    test('handles circular structures without throwing', () => {
        const obj: Record<string, unknown> = {};
        obj.self = obj;
        // Must not throw, must not recurse forever
        const result = coerceToText(obj);
        expect(typeof result).toBe('string');
    });
});

describe('renderTodoOutput (issue #2011)', () => {
    const labels = {
        total: 'Total',
        inProgress: 'In progress',
        pending: 'Pending',
        completed: 'Completed',
        cancelled: 'Cancelled',
    };

    test('returns null for invalid JSON', () => {
        expect(renderTodoOutput('not json', labels)).toBeNull();
    });

    test('returns null when parsed value is not an array', () => {
        expect(renderTodoOutput(JSON.stringify({ foo: 'bar' }), labels)).toBeNull();
    });

    test('renders valid todo arrays', () => {
        const output = JSON.stringify([
            { id: '1', content: 'Do the thing', status: 'pending', priority: 'high' },
        ]);
        const result = renderTodoOutput(output, labels);
        expect(result).not.toBeNull();
    });

    test('filters out todos with non-string content (the {TODO} object case)', () => {
        // The exact pathological shape from the issue: a todo where content
        // is an object instead of a string. Previously this triggered
        // React error #31 when rendered as {todo.content}.
        const output = JSON.stringify([
            { id: '1', content: { TODO: 'Review the diff' }, status: 'pending' },
            { id: '2', content: 'Real string content', status: 'completed' },
        ]);
        // Must not throw. Either returns valid React element (with bad row
        // filtered out) or null.
        const result = renderTodoOutput(output, labels);
        expect(result).not.toBeNull();
    });

    test('returns null when all todos have non-string content', () => {
        const output = JSON.stringify([
            { id: '1', content: { TODO: 'x' }, status: 'pending' },
            { id: '2', content: { foo: 'bar' }, status: 'completed' },
        ]);
        expect(renderTodoOutput(output, labels)).toBeNull();
    });

    test('filters out todos with non-string status', () => {
        const output = JSON.stringify([
            { id: '1', content: 'Valid', status: { broken: true } },
            { id: '2', content: 'Valid', status: 'pending' },
        ]);
        const result = renderTodoOutput(output, labels);
        expect(result).not.toBeNull();
    });

    test('renders a flat list in source order without label headings', () => {
        const output = JSON.stringify([
            { id: '1', content: 'Pending first', status: 'pending' },
            { id: '2', content: 'Completed second', status: 'completed' },
            { id: '3', content: 'Cancelled third', status: 'cancelled' },
            { id: '4', content: 'Active fourth', status: 'in_progress' },
            { id: '5', content: 'Active fifth', status: 'in_progress' },
        ]);
        const result = renderTodoOutput(output, { ...labels, total: 'Injected todo title' });
        const markup = renderToStaticMarkup(React.createElement(I18nProvider, null, result));

        expect(markup).not.toContain('Injected todo title');
        expect(markup.indexOf('Pending first')).toBeLessThan(markup.indexOf('Completed second'));
        expect(markup.indexOf('Completed second')).toBeLessThan(markup.indexOf('Cancelled third'));
        expect(markup.indexOf('Cancelled third')).toBeLessThan(markup.indexOf('Active fourth'));
        expect(markup).toContain('line-through');
        expect(markup).toContain('#yuri-checkbox-circle');
        expect(markup.match(/aria-current="step"/g)?.length).toBe(1);
    });
});
