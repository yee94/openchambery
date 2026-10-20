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
      const saved = readSpeechSettings();
      res.set('X-Speech-Pitch', String(saved.speechPitch)).set('X-Speech-Volume', String(saved.speechVolume));
      if (saved.voiceProvider === 'volcengine') {
        const speech = { text: req.body?.text, apiKey: saved.apiKey, voice: saved.voice, resourceId: saved.resourceId, speed: saved.speechRate };
        if (typeof speech.apiKey !== 'string' || !speech.apiKey.trim()) {
          return res.status(400).json({ error: 'Volcengine speech API Key is required' });
        }
        const abort = new AbortController();
        const cancel = () => { if (!res.writableEnded) abort.abort(); };
        res.on('close', cancel);
        try {
          if (req.headers.accept?.includes('application/x-ndjson')) {
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
      if (!['openai', 'openai-compatible'].includes(saved.voiceProvider)) {
        return res.status(400).json({ error: 'Select a server speech provider in Voice settings' });
      }
      const compatible = saved.voiceProvider === 'openai-compatible';
      const text = req.body?.text;
      const voice = compatible ? saved.openaiCompatibleVoice : saved.openaiVoice;
      const model = compatible ? saved.openaiCompatibleTtsModel : 'gpt-4o-mini-tts';
      const speed = saved.speechRate;
      const apiKey = compatible ? saved.openaiCompatibleApiKey : saved.openaiApiKey;
      const baseURL = compatible ? saved.openaiCompatibleUrl : undefined;

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

      // Use saved speech credentials or the Host's OpenCode credential source.
      const hasSavedKey = apiKey && typeof apiKey === 'string' && apiKey.trim().length > 0;
      const hasCustomBaseURL = typeof normalizedBaseURL === 'string' && normalizedBaseURL.length > 0;
      const hasServerKey = !hasSavedKey && !hasCustomBaseURL && await ttsService.isAvailable();
      
      if (!hasServerKey && !hasSavedKey && !hasCustomBaseURL) {
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
        apiKey: hasSavedKey ? apiKey.trim() : undefined,
        baseURL: hasCustomBaseURL ? normalizedBaseURL : undefined,
      });

      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Content-Length', result.buffer.length);
      res.send(result.buffer);
      } catch (error) {
        console.error('[TTS] Error:', error);
        if (!res.headersSent) {
          res.status(500).json({ 
            error: error instanceof Error ? error.message : 'TTS generation failed',
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
      const saved = readSpeechSettings();
      res.json({
        available: saved.voiceProvider === 'volcengine' ? Boolean(saved.apiKey)
          : saved.voiceProvider === 'openai-compatible' ? Boolean(saved.openaiCompatibleUrl)
          : saved.voiceProvider === 'openai' && (Boolean(saved.openaiApiKey) || await ttsService.isAvailable()),
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
      const { text } = req.body || {};
      const saved = readSpeechSettings();
      const voice = saved.sayVoice;
      const rate = Math.round(100 + (saved.speechRate - 0.5) * 200);
      
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
        const saved = readSpeechSettings();
        const baseURL = saved.sttServerUrl;
        const model = saved.sttModel;
        const language = saved.sttLanguage || undefined;
        const apiKey = saved.sttApiKey || undefined;

        if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
          return res.status(400).json({ error: 'Audio data is required' });
        }

        if (saved.sttProvider === 'volcengine') {
          const abort = new AbortController();
          const cancel = () => { if (!res.writableEnded) abort.abort(); };
          res.on('close', cancel);
          try {
            const speechKey = saved.apiKey;
            if (!speechKey) return res.status(400).json({ error: 'Volcengine speech API Key is required' });
            const transcript = await transcribeVolcengine({ audioBuffer: req.body, apiKey: speechKey, signal: abort.signal });
            if (!res.destroyed) res.json({ transcript });
          } finally {
            res.off('close', cancel);
          }
          return;
        }

        if (saved.sttProvider !== 'openai-compatible' || !baseURL) {
          return res.status(400).json({ error: 'Configure a file transcription provider in Voice settings' });
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
