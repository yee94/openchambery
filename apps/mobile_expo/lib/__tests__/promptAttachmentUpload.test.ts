import { describe, expect, it, vi } from 'vitest';

import type { ActiveRuntime } from '@/lib/connectionController';
import {
  isHeicLike,
  toPromptAttachmentFileUrl,
  uploadPromptAttachmentBytes,
  PromptAttachmentUploadError,
} from '@/lib/promptAttachmentUpload';

const activeDirect = (url = 'http://127.0.0.1:2606'): ActiveRuntime => ({
  connectionId: 'c1',
  label: 'local',
  candidates: [{ kind: 'direct', url }],
  transport: { kind: 'direct', url },
  clientToken: 'token-1',
});

describe('promptAttachmentUpload', () => {
  it('builds file:// urls', () => {
    expect(toPromptAttachmentFileUrl('/data/openchamber/prompt-attachments/ab/x.png')).toBe(
      'file:///data/openchamber/prompt-attachments/ab/x.png',
    );
  });

  it('detects HEIC-like names/mimes', () => {
    expect(isHeicLike('image/heic', 'photo.HEIC')).toBe(true);
    expect(isHeicLike('image/jpeg', 'photo.jpg')).toBe(false);
  });

  it('PUT /api/fs/prompt-attachments/:id', async () => {
    const calls: { url: string; method?: string; headers?: HeadersInit }[] = [];
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method, headers: init?.headers });
      return new Response(
        JSON.stringify({
          path: '/data/openchamber/prompt-attachments/ab/uploaded.bin',
          mime: 'image/png',
          size: 4,
          sha256: 'abc',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch);

    const body = new Uint8Array([1, 2, 3, 4]).buffer;
    const result = await uploadPromptAttachmentBytes(activeDirect(), {
      body,
      mime: 'image/png',
      filename: 'photo.png',
    });
    expect(result.path).toContain('prompt-attachments');
    expect(result.url.startsWith('file://')).toBe(true);
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toContain('/api/fs/prompt-attachments/');
    vi.unstubAllGlobals();
  });

  it('rejects oversized bodies', async () => {
    await expect(
      uploadPromptAttachmentBytes(activeDirect(), {
        body: new ArrayBuffer(26 * 1024 * 1024),
        mime: 'application/octet-stream',
      }),
    ).rejects.toBeInstanceOf(PromptAttachmentUploadError);
  });
});
