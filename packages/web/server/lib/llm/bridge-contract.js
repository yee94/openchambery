import { Rpc } from '@opencode/schema/rpc';

const object = { type: 'object', additionalProperties: true };
export const LLM_BRIDGE_VERSION = 2;
export const LlmBridge = Rpc.define({
  id: 'yuri.llm',
  methods: {
    ready: { input: { type: 'object', additionalProperties: false }, output: { type: 'object', properties: { version: { type: 'integer' } }, required: ['version'], additionalProperties: false } },
    generate: {
      input: {
        type: 'object',
        properties: {
          providerID: { type: 'string', minLength: 1 }, modelID: { type: 'string', minLength: 1 }, variant: { type: 'string' },
          messages: { type: 'array', minItems: 1, items: object }, tools: { type: 'array', items: object },
          cacheKey: { type: 'string', minLength: 1, maxLength: 256 }, maxOutputTokens: { type: 'integer', minimum: 1 },
        },
        required: ['providerID', 'modelID', 'messages', 'cacheKey'], additionalProperties: false,
      },
      output: object,
      errors: { unavailable: object, generation_failed: object },
    },
  },
  events: {},
});
