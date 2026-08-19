import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveTranscriptCacheDbPath } from './resolve-db-path.js';

describe('resolveTranscriptCacheDbPath', () => {
  it('defaults to null so remote Web servers do not persist bodies', () => {
    expect(resolveTranscriptCacheDbPath({}, {})).toBeNull();
    expect(resolveTranscriptCacheDbPath(undefined, {})).toBeNull();
  });

  it('returns the explicit string path', () => {
    expect(resolveTranscriptCacheDbPath({ transcriptCacheDbPath: '/custom/transcript-cache.sqlite' }, {})).toBe(
      '/custom/transcript-cache.sqlite',
    );
  });

  it('returns null when transcriptCacheDbPath is explicitly null', () => {
    expect(resolveTranscriptCacheDbPath(
      { transcriptCacheDbPath: null },
      { OPENCHAMBER_TRANSCRIPT_CACHE_DB_PATH: '/env/transcript-cache.sqlite' },
    )).toBeNull();
  });

  it('uses the environment variable when no explicit path is provided', () => {
    expect(resolveTranscriptCacheDbPath(
      {},
      { OPENCHAMBER_TRANSCRIPT_CACHE_DB_PATH: '/env/transcript-cache.sqlite' },
    )).toBe('/env/transcript-cache.sqlite');
  });

  it('ignores empty or whitespace-only explicit paths and falls through to env', () => {
    expect(resolveTranscriptCacheDbPath(
      { transcriptCacheDbPath: '' },
      { OPENCHAMBER_TRANSCRIPT_CACHE_DB_PATH: '/env/transcript-cache.sqlite' },
    )).toBe('/env/transcript-cache.sqlite');
    expect(resolveTranscriptCacheDbPath(
      { transcriptCacheDbPath: '   ' },
      { OPENCHAMBER_TRANSCRIPT_CACHE_DB_PATH: '/env/transcript-cache.sqlite' },
    )).toBe('/env/transcript-cache.sqlite');
  });

  it('returns null when both the option and env are empty', () => {
    expect(resolveTranscriptCacheDbPath({ transcriptCacheDbPath: '' }, { OPENCHAMBER_TRANSCRIPT_CACHE_DB_PATH: '' })).toBeNull();
    expect(resolveTranscriptCacheDbPath({ transcriptCacheDbPath: '   ' }, { OPENCHAMBER_TRANSCRIPT_CACHE_DB_PATH: '   ' })).toBeNull();
  });

  it('normalizes explicit and env paths to an absolute .sqlite file', () => {
    expect(resolveTranscriptCacheDbPath(
      { transcriptCacheDbPath: ' /tmp/foo/../transcript-cache.sqlite ' },
      {},
    )).toBe(path.resolve('/tmp/transcript-cache.sqlite'));
    expect(resolveTranscriptCacheDbPath(
      {},
      { OPENCHAMBER_TRANSCRIPT_CACHE_DB_PATH: '/env/foo/../transcript-cache.sqlite' },
    )).toBe(path.resolve('/env/transcript-cache.sqlite'));
  });

  it('rejects non-sqlite files and managed database basenames', () => {
    expect(resolveTranscriptCacheDbPath({ transcriptCacheDbPath: '/data/cache.db' }, {})).toBeNull();
    expect(resolveTranscriptCacheDbPath({ transcriptCacheDbPath: '/data/transcript-cache' }, {})).toBeNull();
    expect(resolveTranscriptCacheDbPath({ transcriptCacheDbPath: '/data/session-index.sqlite' }, {})).toBeNull();
    expect(resolveTranscriptCacheDbPath({ transcriptCacheDbPath: '/data/foo/../message-queue.sqlite' }, {})).toBeNull();
    expect(resolveTranscriptCacheDbPath(
      { transcriptCacheDbPath: '/data/Session-Index.sqlite' },
      { OPENCHAMBER_TRANSCRIPT_CACHE_DB_PATH: '/env/transcript-cache.sqlite' },
    )).toBeNull();
    expect(resolveTranscriptCacheDbPath(
      {},
      { OPENCHAMBER_TRANSCRIPT_CACHE_DB_PATH: '/env/message-queue.sqlite' },
    )).toBeNull();
  });
});
