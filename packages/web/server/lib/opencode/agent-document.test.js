import { describe, expect, it } from 'vitest';

import { applyNativePatch, convertAgentConfig, inspectAgentConfig } from './agent-document.js';

describe('inspectAgentConfig', () => {
  it('treats a native file as current', () => {
    expect(inspectAgentConfig({
      description: 'Reviewer',
      mode: 'subagent',
      model: 'openai/gpt-5#high',
      hidden: true,
      color: '#ff6b6b',
      steps: 5,
      permissions: [{ action: 'shell', resource: '*', effect: 'ask' }],
    })).toEqual({ legacy: false, dropped: [] });
  });

  it('reports fields the next request does not use', () => {
    const inspection = inspectAgentConfig({
      temperature: 0.2,
      top_p: 0.9,
      options: { reasoningEffort: 'high' },
      prompt: '{file:./prompt.md}',
      color: 'red',
      variant: 'high',
      extra: true,
    });
    expect(inspection.legacy).toBe(true);
    expect(inspection.dropped).toEqual([
      { key: 'temperature', reason: 'generation' },
      { key: 'top_p', reason: 'generation' },
      { key: 'options', reason: 'unknown' },
      { key: 'prompt', reason: 'prompt-file' },
      { key: 'color', reason: 'color' },
      { key: 'variant', reason: 'variant' },
      { key: 'extra', reason: 'unknown' },
    ]);
  });
});

describe('convertAgentConfig', () => {
  it('folds a legacy agent into native markdown fields', () => {
    const converted = convertAgentConfig({
      description: 'Reviewer',
      mode: 'subagent',
      model: 'openai/gpt-5',
      variant: 'high',
      temperature: 0.2,
      prompt: 'Be careful.',
      permission: { bash: 'ask', task: 'allow', write: 'deny' },
      tools: { write: false },
      maxSteps: 4,
      disable: true,
      color: '#112233',
      request: { body: { temperature: 0.2 } },
    });

    expect(converted.legacy).toBe(true);
    expect(converted.body).toBe('Be careful.');
    expect(converted.frontmatter).toMatchObject({
      description: 'Reviewer',
      mode: 'subagent',
      model: 'openai/gpt-5#high',
      steps: 4,
      disabled: true,
      color: '#112233',
      request: { body: { temperature: 0.2 } },
    });
    expect(converted.frontmatter).not.toHaveProperty('temperature');
    expect(converted.frontmatter).not.toHaveProperty('hidden');
    expect(converted.frontmatter.permissions).toEqual(expect.arrayContaining([
      { action: 'shell', resource: '*', effect: 'ask' },
      { action: 'subagent', resource: '*', effect: 'allow' },
      { action: 'edit', resource: '*', effect: 'deny' },
    ]));
  });
});

describe('applyNativePatch', () => {
  it('clears nullable fields and drops empty permissions', () => {
    const next = applyNativePatch({
      frontmatter: {
        model: 'openai/gpt-5',
        hidden: true,
        permissions: [{ action: 'read', resource: '*', effect: 'allow' }],
        variant: 'high',
        temperature: 1,
      },
      body: 'old',
    }, {
      model: null,
      hidden: false,
      permissions: [],
      system: null,
      steps: 0,
    });

    expect(next.body).toBe('');
    expect(next.frontmatter).toEqual({});
  });
});
