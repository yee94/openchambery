import { describe, expect, test } from 'bun:test';

import {
  canonicalizeModelForBrand,
  getModelBrandLogoCandidates,
  resolveModelBrand,
} from './modelBrand';

describe('modelBrand', () => {
  test('canonicalizes channel suffixes and context window markers', () => {
    expect(canonicalizeModelForBrand('glm-5.2-ioa')).toBe('glm-5-2');
    expect(canonicalizeModelForBrand('deepseek-v4-pro-official')).toBe('deepseek-v4-pro');
    expect(canonicalizeModelForBrand('Claude-Opus-4.8-1m')).toBe('claude-opus-4-8');
    expect(canonicalizeModelForBrand('hy3-ioa')).toBe('hy');
  });

  test('resolves brand from model name even when provider is an aggregator', () => {
    expect(resolveModelBrand('claude-sonnet-4-5', 'openrouter')).toBe('claude');
    expect(resolveModelBrand('anthropic/claude-opus-4-7-fast', 'openrouter')).toBe('claude');
    expect(resolveModelBrand('gpt-4o-mini', 'openrouter')).toBe('gpt');
    expect(resolveModelBrand('openai/gpt-5.4-mini-fast', 'boxai')).toBe('gpt');
    expect(resolveModelBrand('gemini-2.5-flash', 'openrouter')).toBe('gemini');
    expect(resolveModelBrand('glm-5.2-ioa', 'codebuddy')).toBe('glm');
    expect(resolveModelBrand('deepseek-v4-pro-official', 'astra')).toBe('deepseek');
    expect(resolveModelBrand('qwen3-coder', 'aliyun')).toBe('qwen');
    expect(resolveModelBrand('kimi-k2', 'moonshot')).toBe('kimi');
    expect(resolveModelBrand('grok-4-1-fast', 'xai')).toBe('grok');
    expect(resolveModelBrand('minimax-m1', 'minimax')).toBe('minimax');
  });

  test('maps openai o-series models to gpt brand', () => {
    expect(resolveModelBrand('o3', 'openai')).toBe('gpt');
    expect(resolveModelBrand('o4-mini', 'openrouter')).toBe('gpt');
  });

  test('falls back to provider brand aliases when model name is opaque', () => {
    expect(resolveModelBrand('custom-router-v1', 'anthropic')).toBe('claude');
    expect(resolveModelBrand('custom-router-v1', 'openai')).toBe('gpt');
    expect(resolveModelBrand('custom-router-v1', 'google')).toBe('gemini');
    expect(resolveModelBrand('custom-router-v1', 'zhipuai')).toBe('glm');
  });

  test('returns null when neither model nor provider yields a brand', () => {
    expect(resolveModelBrand('mystery-model-xyz', 'my-aggregator')).toBeNull();
  });

  test('exposes logo candidates for local lookup', () => {
    expect(getModelBrandLogoCandidates('claude')).toEqual(['claude', 'anthropic']);
    expect(getModelBrandLogoCandidates('gpt')).toEqual(['gpt', 'openai']);
    expect(getModelBrandLogoCandidates('hy')).toEqual(['hunyuan', 'hy']);
    expect(getModelBrandLogoCandidates('glm')).toEqual(['zai-coding-plan', 'zhipuai-coding-plan', 'glm']);
    expect(getModelBrandLogoCandidates('kimi')).toEqual(['kimi']);
    expect(getModelBrandLogoCandidates('qwen')).toEqual(['qwen']);
    expect(getModelBrandLogoCandidates('llama')).toEqual([]);
  });

  test('resolves glm from z.ai coding plan provider id', () => {
    expect(resolveModelBrand('glm-5.2', 'zai-coding-plan')).toBe('glm');
    expect(resolveModelBrand('glm-4.7', 'zhipuai-coding-plan')).toBe('glm');
  });

  test('resolves hunyuan and cursor composer models', () => {
    expect(resolveModelBrand('hy3-free', 'poe')).toBe('hy');
    expect(resolveModelBrand('composer-2.5', 'api-for-cursor')).toBe('composer');
    expect(resolveModelBrand('composer-2.5-fast', 'api-for-cursor')).toBe('composer');
    expect(getModelBrandLogoCandidates('hy')).toEqual(['hunyuan', 'hy']);
    expect(getModelBrandLogoCandidates('composer')).toEqual(['cursor', 'composer']);
  });

  test('resolves grok and gemini logo candidates', () => {
    expect(resolveModelBrand('grok-4-1-fast', 'xai')).toBe('grok');
    expect(resolveModelBrand('gemini-2.5-flash', 'google')).toBe('gemini');
    expect(getModelBrandLogoCandidates('grok')).toEqual(['grok']);
    expect(getModelBrandLogoCandidates('gemini')).toEqual(['google', 'gemini']);
  });
});
