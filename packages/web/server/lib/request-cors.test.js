import { describe, expect, it } from 'bun:test';

import { applyRuntimeCorsHeaders } from './request-cors.js';

describe('applyRuntimeCorsHeaders', () => {
  it('gives packaged clients a reusable preflight cache window', () => {
    const headers = new Map();
    applyRuntimeCorsHeaders({
      origin: 'yuri-ui://app',
      setHeader: (name, value) => headers.set(name, value),
    });
    expect(headers.get('Access-Control-Max-Age')).toBe('600');
    expect(headers.get('Access-Control-Allow-Origin')).toBe('yuri-ui://app');
    expect(headers.get('Access-Control-Allow-Headers')).toContain('X-Message-Queue-Upload-Token');
    expect(headers.get('Access-Control-Allow-Headers')).toContain('X-Message-Queue-Sha256');
    expect(headers.get('Access-Control-Allow-Headers')).toContain('X-Message-Queue-Content-Length');
    expect(headers.get('Access-Control-Allow-Headers')).toContain('X-Yuri-Mime');
    expect(headers.get('Access-Control-Allow-Headers')).toContain('X-Yuri-Sha256');
    expect(headers.get('Access-Control-Allow-Headers')).toContain('X-Yuri-Content-Length');
    expect(headers.get('Access-Control-Allow-Headers')).toContain('X-Yuri-Filename');
    expect(headers.get('Access-Control-Allow-Headers')).toContain('X-Yuri-Gui-Revision');
    expect(headers.get('Access-Control-Expose-Headers')).toContain('x-yuri-gui-revision');
    expect(headers.get('Access-Control-Expose-Headers')).toContain('x-yuri-gui-code');
    expect(headers.get('Access-Control-Expose-Headers')).toContain('x-next-cursor');
    expect(headers.get('Access-Control-Expose-Headers')).toContain('x-yuri-file-exists');
  });
});
