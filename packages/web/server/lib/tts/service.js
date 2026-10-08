/**
 * Server-side Text-to-Speech Service
 *
 * Uses OpenAI's TTS API to generate audio on the server and stream it to clients.
 * This bypasses mobile Safari's audio context restrictions.
 */

import OpenAI from 'openai';
import { readOpenCodeCredentials } from '../opencode/auth.js';
import { normalizeCustomOpenAIBaseURL } from './base-url.js';

// Voice options from OpenAI
export const TTS_VOICES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable',
  'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'
];

async function getOpenAIApiKey() {
  const auth = await readOpenCodeCredentials();
  const entry = auth.openai || auth.codex || auth.chatgpt;
  return entry?.type === 'api' ? entry.key : entry?.access || null;
}

class TTSService {
  constructor() {
    this._client = null;
    this._lastApiKey = null;
  }

  async _getClient() {
    const apiKey = await getOpenAIApiKey();
    if (!apiKey) {
      this._client = null;
      this._lastApiKey = null;
      return null;
    }

    // If API key changed or client doesn't exist, create new client
    if (apiKey && (!this._client || this._lastApiKey !== apiKey)) {
      this._client = new OpenAI({ apiKey });
      this._lastApiKey = apiKey;
    }

    return this._client;
  }

  async isAvailable() {
    return (await this._getClient()) !== null;
  }

  /**
   * Generate speech and return as a stream
   */
  async generateSpeechStream(options) {
    const {
      text,
      voice = 'coral',
      model = 'gpt-4o-mini-tts',
      speed = 1.0,
      instructions,
      apiKey,
      baseURL,
    } = options;

    const normalizedBaseURLResult = normalizeCustomOpenAIBaseURL(baseURL);
    if (normalizedBaseURLResult.error) {
      throw new Error(normalizedBaseURLResult.error);
    }
    const normalizedBaseURL = normalizedBaseURLResult.value;

    // Use provided API key / baseURL or fall back to configured key
    let client;
    if (normalizedBaseURL || apiKey) {
      const clientOpts = {};
      if (apiKey) clientOpts.apiKey = apiKey;
      if (!apiKey) clientOpts.apiKey = 'not-required';
      if (normalizedBaseURL) clientOpts.baseURL = normalizedBaseURL;
      client = new OpenAI(clientOpts);
    } else {
      client = await this._getClient();
    }

    if (!client) {
      throw new Error('TTS service not available. Configure OpenAI in OpenCode, provide an API key, or set a custom server URL in settings.');
    }

    if (!text.trim()) {
      throw new Error('Text is required for TTS');
    }

    try {
      // OpenAI-compatible servers (custom baseURL) may not support `instructions`
      // or `response_format`, but do support `speed`. Send the safe subset.
      const speechParams = normalizedBaseURL
        ? { model, voice, input: text, speed }
        : {
            model,
            voice,
            input: text,
            speed,
            ...(instructions && { instructions }),
            response_format: 'mp3',
          };

      console.log('[TTSService] Generating speech — model:', model, 'voice:', voice, 'baseURL:', normalizedBaseURL ?? '(openai)');
      const response = await client.audio.speech.create(speechParams);

      const arrayBuffer = await response.arrayBuffer();
      return {
        buffer: Buffer.from(arrayBuffer),
        contentType: 'audio/mpeg',
      };
    } catch (error) {
      console.error('[TTSService] Error generating speech:', error);
      throw new Error(`Failed to generate speech: ${error.message || 'Unknown error'}`);
    }
  }

  /**
   * Generate speech and return as a buffer (for caching)
   */
  async generateSpeechBuffer(options) {
    const client = await this._getClient();
    if (!client) {
      throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY environment variable or configure OpenAI in OpenCode.');
    }

    const {
      text,
      voice = 'coral',
      model = 'gpt-4o-mini-tts',
      speed = 1.0,
      instructions
    } = options;

    try {
      const response = await client.audio.speech.create({
        model,
        voice,
        input: text,
        speed,
        ...(instructions && { instructions }),
        response_format: 'mp3',
      });

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      console.error('[TTSService] Error generating speech buffer:', error);
      throw error;
    }
  }
}

// Export singleton instance
export const ttsService = new TTSService();
export { TTSService };
