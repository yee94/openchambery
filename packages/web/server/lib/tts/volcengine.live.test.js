import { expect, it } from 'vitest';
import { synthesizeVolcengine, transcribeVolcengine } from './volcengine.js';

// Opt-in: the account must enable both speech services. No key or audio is logged.
it.skipIf(!process.env.VOLCENGINE_SPEECH_API_KEY)('synthesizes Chinese speech and recognizes the resulting MP3 with Doubao', async () => {
  const apiKey = process.env.VOLCENGINE_SPEECH_API_KEY;
  const { buffer, contentType } = await synthesizeVolcengine({ apiKey, text: '今天阳光很好，我们一起去公园散步。' });
  expect(contentType).toBe('audio/mpeg');
  expect(buffer.length).toBeGreaterThan(1000);
  const transcript = await transcribeVolcengine({ apiKey, audioBuffer: buffer });
  expect(transcript).toContain('阳光');
  expect(transcript).toContain('公园');
}, 120000);
