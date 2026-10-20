import express from 'express';
import { once } from 'node:events';
import { normalizeCustomOpenAIBaseURL } from './base-url.js';
import { summarizeText, sanitizeForTTS, sanitizeForNote } from '../text/summarization.js';
import { synthesizeVolcengine, transcribeVolcengine } from './volcengine.js';
import { readSpeechSettings, registerSpeechSettingsRoutes } from './settings.js';

export function registerTtsRoutes(app, { sayTTSCapability }) {
  registerSpeechSettingsRoutes(app);
  let ttsModulePromise = null;
  const getTtsModule = async () => {
    if (!ttsModulePromise) {
      ttsModulePromise = import('./index.js');
    }
    return ttsModulePromise;
  };

  app.post('/api/voice/token', async (req, res) => {
    console.log('[Voice] Token request received:', {
      contentType: req.headers['content-type'] || null,
    });
    try {
      const openaiApiKey = process.env.OPENAI_API_KEY;
      console.log('[Voice] OpenAI API Key present:', !!openaiApiKey);

      if (!openaiApiKey) {
        return res.status(503).json({
          allowed: false,
          error: 'OpenAI voice service not configured. Set OPENAI_API_KEY environment variable.'
        });
      }

      // Return success - OpenAI TTS is available
      res.json({
        allowed: true,
        provider: 'openai',
        message: 'OpenAI TTS is available'
      });
    } catch (error) {
      console.error('[Voice] Token generation error:', error);
      res.status(500).json({
        allowed: false,
        error: 'Voice service error'
      });
    }
  });

  // Server-side TTS endpoint - streams audio from OpenAI TTS API
  app.post('/api/tts/speak', async (req, res) => {
    try {
      if (req.body?.provider === 'volcengine') {
        const saved = readSpeechSettings();
        const speech = { ...saved, ...req.body, apiKey: req.body.apiKey || saved.apiKey };
        if (typeof speech.apiKey !== 'string' || !speech.apiKey.trim()) {
          return res.status(400).json({ error: 'Volcengine speech API Key is required' });
        }
        const abort = new AbortController();
        const cancel = () => { if (!res.writableEnded) abort.abort(); };
        res.on('close', cancel);
        try {
          if (req.body.stream === true) {
            res.type('application/x-ndjson').set('Cache-Control', 'no-store, no-transform').set('X-Accel-Buffering', 'no');
            const write = async (frame) => {
              abort.signal.throwIfAborted();
              if (!res.write(`${JSON.stringify(frame)}\n`)) await once(res, 'drain', { signal: abort.signal });
              res.flush?.();
            };
            await synthesizeVolcengine({ ...speech, signal: abort.signal, onAudio: async (chunk) => {
              for (let offset = 0; offset < chunk.length; offset += 9600) {
                await write({ type: 'audio', data: chunk.subarray(offset, offset + 9600).toString('base64') });
              }
            } });
            await write({ type: 'done' });
            res.end();
            return;
          }
          const result = await synthesizeVolcengine({ ...speech, signal: abort.signal, onAudio: undefined });
          if (!res.destroyed) res.type(result.contentType).set('Cache-Control', 'no-store').send(result.buffer);
        } catch (error) {
          if (res.headersSent) {
            if (!res.destroyed) res.end(`${JSON.stringify({ type: 'error', error: 'Speech synthesis interrupted or failed' })}\n`);
          } else {
            throw error;
          }
        } finally {
          res.off('close', cancel);
        }
        return;
      }
      const saved = readSpeechSettings();
      const compatible = req.body?.provider === 'openai-compatible';
      const matchesSavedUrl = !req.body?.baseURL || normalizeCustomOpenAIBaseURL(req.body.baseURL).value === normalizeCustomOpenAIBaseURL(saved.openaiCompatibleUrl).value;
      const savedApiKey = compatible ? (matchesSavedUrl ? saved.openaiCompatibleApiKey : undefined) : (req.body?.baseURL ? undefined : saved.openaiApiKey);
      const { text, voice = compatible ? saved.openaiCompatibleVoice : saved.openaiVoice,
        model = compatible ? saved.openaiCompatibleTtsModel : 'gpt-4o-mini-tts', speed = saved.speechRate,
        instructions, providerId, modelId, apiKey = savedApiKey,
        baseURL = compatible ? saved.openaiCompatibleUrl : undefined } = req.body || {};

      const normalizedBaseURLResult = normalizeCustomOpenAIBaseURL(baseURL);
      if (normalizedBaseURLResult.error) {
        return res.status(400).json({ error: normalizedBaseURLResult.error });
      }
      const normalizedBaseURL = normalizedBaseURLResult.value;

      console.log('[TTS] Request received:', { voice, model, speed, textLength: text?.length, hasApiKey: !!apiKey, hasBaseURL: !!baseURL });

      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Text is required' });
      }

      // Dynamically import the TTS service (ESM)
      const { ttsService } = await getTtsModule();

      // Check availability - server-configured key, client-provided key, or custom server URL
      const hasClientKey = apiKey && typeof apiKey === 'string' && apiKey.trim().length > 0;
      const hasCustomBaseURL = typeof normalizedBaseURL === 'string' && normalizedBaseURL.length > 0;
      const hasServerKey = !hasClientKey && !hasCustomBaseURL && await ttsService.isAvailable();
      
      if (!hasServerKey && !hasClientKey && !hasCustomBaseURL) {
        return res.status(503).json({ 
          error: 'TTS service not available. Please configure OpenAI in OpenCode, provide an API key, or set a custom server URL in settings.' 
        });
      }

      let textToSpeak = text.trim();

      // Historical summarize request fields are intentionally ignored. The
      // model-backed summarization provider is retired.

      const result = await ttsService.generateSpeechStream({
        text: textToSpeak,
        voice,
        model,
        speed,
        instructions,
        apiKey: hasClientKey ? apiKey.trim() : undefined,
        baseURL: hasCustomBaseURL ? normalizedBaseURL : undefined,
      });

      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Content-Length', result.buffer.length);
      res.send(result.buffer);
      } catch (error) {
        console.error('[TTS] Error:', error);
        if (!res.headersSent) {
          const { model: m, voice: v, baseURL: b } = req.body || {};
          res.status(500).json({ 
            error: error instanceof Error ? error.message : 'TTS generation failed',
            detail: { model: m, voice: v, hasBaseURL: !!b },
          });
        }
      }
  });

  app.post('/api/text/summarize', async (req, res) => {
    try {
      const { text, threshold = 200, maxLength = 500, mode } = req.body || {};

      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Text is required' });
      }

      const result = await summarizeText({
        text,
        threshold,
        maxLength,
        mode: typeof mode === 'string' ? mode : 'tts',
      });

      return res.json(result);
    } catch (error) {
      console.error('[Summarize] Error:', error);
      const sanitized = typeof req.body?.mode === 'string' && req.body.mode === 'note'
        ? sanitizeForNote(req.body?.text || '')
        : sanitizeForTTS(req.body?.text || '');
      return res.json({ summary: sanitized, summarized: false, reason: error.message });
    }
  });

       
  // TTS status endpoint
  app.get('/api/tts/status', async (_req, res) => {
    try {
      const { ttsService } = await getTtsModule();
      res.json({
        available: Boolean(readSpeechSettings().openaiApiKey) || await ttsService.isAvailable(),
        voices: [
          'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable',
          'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'
        ]
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to check TTS status' });
    }
  });

  // macOS 'say' command TTS status endpoint - returns cached capability from startup
  app.get('/api/tts/say/status', (_req, res) => {
    res.json(sayTTSCapability);
  });

  // macOS 'say' command TTS speak endpoint
  app.post('/api/tts/say/speak', async (req, res) => {
    try {
      const { text, voice = 'Samantha', rate = 200 } = req.body || {};
      
      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Text is required' });
      }
      
      // Check if we're on macOS
      if (process.platform !== 'darwin') {
        return res.status(503).json({ error: 'macOS say command not available on this platform' });
      }
      
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const execAsync = promisify(exec);
      
      // Create temp file for audio output (use m4a for browser compatibility)
      const tempDir = os.tmpdir();
      const tempFile = path.join(tempDir, `say-${Date.now()}.m4a`);
      
      // Escape text for shell - escape both single quotes and double quotes
      const escapedText = text.trim().replace(/'/g, "'\\''").replace(/"/g, '\\"');
      
      // Generate audio file using 'say' command
      // -o outputs to file, -r sets rate (words per minute)
      // --data-format=aac outputs as m4a which browsers can decode
      const cmd = `say -v "${voice}" -r ${rate} -o "${tempFile}" --data-format=aac '${escapedText}'`;
      console.log('[TTS-Say] Generating speech:', { textLength: text.length, voice, rate });
      
      await execAsync(cmd);
      
      // Read the generated audio file
      const audioBuffer = await fs.promises.readFile(tempFile);
      
      // Clean up temp file
      fs.promises.unlink(tempFile).catch(() => {});
      
      // Send audio response
      res.setHeader('Content-Type', 'audio/mp4');
      res.setHeader('Content-Length', audioBuffer.length);
      res.send(audioBuffer);
      
    } catch (error) {
      console.error('[TTS-Say] Error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Say command failed'
      });
    }
  });

  // Server-side STT: receive raw audio, proxy to OpenAI-compatible transcription endpoint
  app.post(
    '/api/stt/transcribe',
    express.raw({ type: (req) => (req.headers['content-type'] || '').startsWith('audio/'), limit: '20mb' }),
    async (req, res) => {
      try {
        const { transcribeAudio } = await import('./stt.js');

        const mimeType = (req.headers['content-type'] || 'audio/webm').split(',')[0].trim();
        const baseURL = typeof req.headers['x-base-url'] === 'string' ? req.headers['x-base-url'].trim() : '';
        const model = typeof req.headers['x-model'] === 'string' && req.headers['x-model'].trim().length > 0
          ? req.headers['x-model'].trim()
          : 'deepdml/faster-whisper-large-v3-turbo-ct2';
        const language = typeof req.headers['x-language'] === 'string' && req.headers['x-language'].trim().length > 0
          ? req.headers['x-language'].trim()
          : undefined;
        const authHeader = typeof req.headers['authorization'] === 'string' ? req.headers['authorization'].trim() : '';
        const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;

        if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
          return res.status(400).json({ error: 'Audio data is required' });
        }

        if (req.headers['x-speech-provider'] === 'volcengine') {
          const abort = new AbortController();
          const cancel = () => { if (!res.writableEnded) abort.abort(); };
          res.on('close', cancel);
          try {
            const speechKey = req.headers['x-speech-api-key'] || readSpeechSettings().apiKey;
            if (!speechKey) return res.status(400).json({ error: 'Volcengine speech API Key is required' });
            const transcript = await transcribeVolcengine({ audioBuffer: req.body, apiKey: speechKey, signal: abort.signal });
            if (!res.destroyed) res.json({ transcript });
          } finally {
            res.off('close', cancel);
          }
          return;
        }

        if (!baseURL) {
          return res.status(400).json({ error: 'X-Base-URL header is required' });
        }

        console.log('[STT] Transcribing audio:', {
          bytes: req.body.length,
          mimeType,
          model,
          baseURL,
          language,
          hasApiKey: !!apiKey,
        });

        const transcript = await transcribeAudio({
          audioBuffer: req.body,
          mimeType,
          model,
          baseURL,
          apiKey,
          language,
        });

        console.log('[STT] Transcript:', transcript?.slice(0, 120));
        res.json({ transcript: transcript ?? '' });
      } catch (error) {
        console.error('[STT] Error:', error);
        if (!res.headersSent) {
          res.status(500).json({
            error: error instanceof Error ? error.message : 'Transcription failed',
          });
        }
      }
    }
  );
}
