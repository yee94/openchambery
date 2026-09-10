import { beforeEach, describe, expect, mock, test } from 'bun:test';

const fetchCalls: Array<{ path: string; init?: RequestInit }> = [];
const fetchResults: Array<Response | Error> = [];

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (path: string, init?: RequestInit) => {
    fetchCalls.push({ path, init });
    const next = fetchResults.shift();
    if (next instanceof Error) throw next;
    return next ?? new Response('missing', { status: 500 });
  }),
}));

const {
  ASSISTANT_ATTACHMENT_MAX_BYTES,
  AssistantAttachmentUploadError,
  digestSha256Hex,
  isAssistantAttachmentDescriptor,
  uploadAssistantAttachment,
} = await import('./assistant-attachment-upload');

beforeEach(() => {
  fetchCalls.length = 0;
  fetchResults.length = 0;
});

const expectCode = async (run: () => Promise<unknown>, code: string) => {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AssistantAttachmentUploadError);
  expect((caught as InstanceType<typeof AssistantAttachmentUploadError>).code).toBe(code);
};

describe('uploadAssistantAttachment', () => {
  test('PUTs raw bytes with integrity headers and returns frozen descriptor', async () => {
    const body = new File([new Uint8Array([1, 2, 3, 4])], 'photo.png', { type: 'image/png' });
    const sha256 = await digestSha256Hex(body);
    fetchResults.push(new Response(JSON.stringify({
      type: 'file',
      attachmentID: 'att-1',
      sha256,
      size: 4,
      mime: 'image/png',
      filename: 'photo.png',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const descriptor = await uploadAssistantAttachment('asst-1', body, 'upload-1');

    expect(descriptor).toEqual({
      type: 'file',
      attachmentID: 'att-1',
      sha256,
      size: 4,
      mime: 'image/png',
      filename: 'photo.png',
    });
    expect(fetchCalls[0]?.path).toBe('/api/openchamber/assistants/asst-1/contact/attachments/upload-1');
    const headers = new Headers(fetchCalls[0]?.init?.headers);
    expect(headers.get('X-Content-SHA256')).toBe(sha256);
    expect(headers.get('X-Content-Size')).toBe('4');
    expect(headers.get('X-Attachment-Filename')).toBe(encodeURIComponent('photo.png'));
  });

  test('rejects oversized files before network', async () => {
    const huge = new File([new Uint8Array(ASSISTANT_ATTACHMENT_MAX_BYTES + 1)], 'big.bin', {
      type: 'application/octet-stream',
    });
    await expectCode(() => uploadAssistantAttachment('a', huge, 'u'), 'too-large');
    expect(fetchCalls).toHaveLength(0);
  });

  test('rejects hash mismatch in response with integrity code', async () => {
    const body = new File([new Uint8Array([9, 9])], 'x.bin', { type: 'application/octet-stream' });
    fetchResults.push(new Response(JSON.stringify({
      type: 'file',
      attachmentID: 'att',
      sha256: 'a'.repeat(64),
      size: 2,
      mime: 'application/octet-stream',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expectCode(() => uploadAssistantAttachment('a', body, 'u'), 'integrity');
  });

  test('rejects empty JSON body', async () => {
    const body = new File([new Uint8Array([1])], 'x.bin', { type: 'application/octet-stream' });
    fetchResults.push(new Response('', { status: 200, headers: { 'content-type': 'application/json' } }));
    await expectCode(() => uploadAssistantAttachment('a', body, 'u'), 'integrity');
  });

  test('rejects 204 empty status', async () => {
    const body = new File([new Uint8Array([1])], 'x.bin', { type: 'application/octet-stream' });
    fetchResults.push(new Response(null, { status: 204 }));
    await expectCode(() => uploadAssistantAttachment('a', body, 'u'), 'integrity');
  });

  test('rejects HTML SPA fallback body', async () => {
    const body = new File([new Uint8Array([1])], 'x.bin', { type: 'application/octet-stream' });
    fetchResults.push(new Response('<!doctype html><html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    await expectCode(() => uploadAssistantAttachment('a', body, 'u'), 'integrity');
  });

  test('rejects missing mime in server descriptor', async () => {
    const body = new File([new Uint8Array([1, 2])], 'x.bin', { type: 'application/octet-stream' });
    const sha256 = await digestSha256Hex(body);
    fetchResults.push(new Response(JSON.stringify({
      type: 'file',
      attachmentID: 'att',
      sha256,
      size: 2,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expectCode(() => uploadAssistantAttachment('a', body, 'u'), 'integrity');
  });

  test('type guard accepts frozen descriptor shape', () => {
    expect(isAssistantAttachmentDescriptor({
      type: 'file',
      attachmentID: 'a',
      sha256: 'b'.repeat(64),
      size: 1,
      mime: 'image/png',
    })).toBe(true);
    expect(isAssistantAttachmentDescriptor({ type: 'file', attachmentID: 'a' })).toBe(false);
  });
});
