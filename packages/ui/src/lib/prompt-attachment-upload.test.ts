import { beforeEach, describe, expect, mock, test } from 'bun:test';

const fetchCalls: Array<{ path: string; init?: RequestInit }> = [];
const fetchResults: Array<Response | Error> = [];

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (path: string, init?: RequestInit) => {
    fetchCalls.push({ path, init });
    const next = fetchResults.shift();
    if (next instanceof Error) throw next;
    return next ?? new Response(JSON.stringify({ success: true, path: '/data/photo.png', size: 4, mime: 'image/png', sha256: 'abcd' }), { status: 200 });
  }),
}));

const { blobFromDataUrl, needsPromptAttachmentUpload, pathFromPromptAttachmentFileUrl, uploadPromptAttachmentBytes, PromptAttachmentUploadError, toPromptAttachmentFileUrl } = await import('./prompt-attachment-upload');

beforeEach(() => {
  fetchCalls.length = 0;
  fetchResults.length = 0;
});

describe('prompt attachment upload', () => {
  test('detects inline data and blob URLs that must leave the prompt JSON', () => {
    expect(needsPromptAttachmentUpload('data:image/png;base64,eA==')).toBe(true);
    expect(needsPromptAttachmentUpload('blob:https://example.test/id')).toBe(true);
    expect(needsPromptAttachmentUpload('file:///tmp/photo.png')).toBe(false);
    expect(needsPromptAttachmentUpload('https://example.test/photo.png')).toBe(false);
  });

  test('decodes a data URL into a typed blob', async () => {
    const blob = blobFromDataUrl('data:image/png;base64,aGVsbA==', 'image/png');
    expect(blob).not.toBeNull();
    expect(blob!.type).toBe('image/png');
    expect(await blob!.text()).toBe('hell');
  });

  test('uploads a Blob body and returns a file:// host path', async () => {
    const body = new Blob(['abcd'], { type: 'image/png' });
    fetchResults.push(new Response(JSON.stringify({
      success: true,
      path: '/data/openchamber/prompt-attachments/ab/abcd.png',
      size: 4,
      mime: 'image/png',
      sha256: 'deadbeef',
    }), { status: 200 }));

    const result = await uploadPromptAttachmentBytes({ body, mime: 'image/png', filename: 'photo.png' });

    expect(result.url).toBe('file:///data/openchamber/prompt-attachments/ab/abcd.png');
    expect(result.path).toBe('/data/openchamber/prompt-attachments/ab/abcd.png');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.path).toMatch(/^\/api\/fs\/prompt-attachments\//);
    expect(fetchCalls[0]?.init?.method).toBe('PUT');
    expect(fetchCalls[0]?.init?.body).toBeInstanceOf(Blob);
    const headers = new Headers(fetchCalls[0]?.init?.headers);
    expect(headers.get('Content-Length')).toBe('4');
    expect(headers.get('X-OpenChamber-Content-Length')).toBe('4');
    expect(headers.get('X-OpenChamber-Mime')).toBe('image/png');
    expect(headers.get('X-OpenChamber-Sha256')).toHaveLength(64);
  });

  test('throws an explicit error instead of falling back to a data URL', async () => {
    fetchResults.push(new TypeError('Failed to fetch'));
    await expect(uploadPromptAttachmentBytes({
      body: new Blob(['abcd'], { type: 'image/png' }),
      mime: 'image/png',
    })).rejects.toThrow(PromptAttachmentUploadError);
  });

  test('encodes Windows drive letters as file:///C:/...', () => {
    expect(toPromptAttachmentFileUrl('C:/Users/demo/photo.png')).toBe('file:///C:/Users/demo/photo.png');
  });

  test('decodes file:// URLs back to host paths', () => {
    expect(pathFromPromptAttachmentFileUrl('file:///data/openchamber/prompt-attachments/ab/abcd.png'))
      .toBe('/data/openchamber/prompt-attachments/ab/abcd.png');
    expect(pathFromPromptAttachmentFileUrl('file:///C:/Users/demo/photo.png')).toBe('C:/Users/demo/photo.png');
  });
});
