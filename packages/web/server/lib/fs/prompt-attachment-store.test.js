import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertImageContentMatchesMime,
  decodeDataUrlStrict,
  relativeObjectPath,
  storePromptAttachmentBytes,
  readPromptAttachmentBytes,
  promptAttachmentsRoot,
} from './prompt-attachment-store.js';

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe,
  0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
  0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const makeDataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pas-'));

describe('prompt-attachment-store', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores content-addressed bytes and rejects path traversal relative paths', async () => {
    const dataDir = makeDataDir();
    const digest = sha256(png);
    const stored = await storePromptAttachmentBytes({
      dataDir,
      buffer: png,
      expectedSha256: digest,
      mime: 'image/png',
      filename: 'x.png',
    });
    expect(stored.relativePath).toBe(relativeObjectPath(digest, 'image/png'));
    expect(stored.sha256).toBe(digest);
    const again = await storePromptAttachmentBytes({
      dataDir,
      buffer: png,
      expectedSha256: digest,
      mime: 'image/png',
      filename: 'x.png',
    });
    expect(again.absolutePath).toBe(stored.absolutePath);
    const read = await readPromptAttachmentBytes(dataDir, stored.relativePath);
    expect(read.buffer.equals(png)).toBe(true);
    await expect(readPromptAttachmentBytes(dataDir, '../etc/passwd')).rejects.toMatchObject({
      code: 'attachment_unsafe_path',
    });
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('rejects image mime/signature mismatch', () => {
    expect(() => assertImageContentMatchesMime(Buffer.from('not-an-image'), 'image/png')).toThrowError(
      expect.objectContaining({ code: 'attachment_mime_mismatch' }),
    );
    expect(() => assertImageContentMatchesMime(png, 'image/png')).not.toThrow();
  });

  describe('decodeDataUrlStrict', () => {
    it('preserves literal plus in non-base64 data URLs (not form-urlencoded spaces)', () => {
      const decoded = decodeDataUrlStrict('data:text/plain,a+b');
      expect(decoded.buffer.toString('utf8')).toBe('a+b');
      expect(decoded.mime).toBe('text/plain');
    });

    it('percent-decodes %2B to plus and rejects malformed percent sequences', () => {
      expect(decodeDataUrlStrict('data:text/plain,a%2Bb').buffer.toString('utf8')).toBe('a+b');
      expect(() => decodeDataUrlStrict('data:text/plain,a%zz')).toThrowError(
        expect.objectContaining({ code: 'validation_error' }),
      );
      expect(() => decodeDataUrlStrict('data:text/plain,a%2')).toThrowError(
        expect.objectContaining({ code: 'validation_error' }),
      );
    });

    it('rejects invalid base64 alphabet and broken padding', () => {
      expect(() => decodeDataUrlStrict('data:text/plain;base64,!!!')).toThrowError(
        expect.objectContaining({ code: 'validation_error' }),
      );
      expect(() => decodeDataUrlStrict('data:text/plain;base64,YWJ')).toThrowError(
        expect.objectContaining({ code: 'validation_error' }),
      );
      expect(() => decodeDataUrlStrict('data:text/plain;base64,YWJj====')).toThrowError(
        expect.objectContaining({ code: 'validation_error' }),
      );
    });

    it('allows html and svg data URLs for ordinary chat source uploads', () => {
      const html = decodeDataUrlStrict('data:text/html,<h1>x</h1>');
      expect(html.buffer.toString('utf8')).toBe('<h1>x</h1>');
      expect(html.mime).toBe('text/html');
      const svg = decodeDataUrlStrict('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"></svg>');
      expect(svg.mime).toBe('image/svg+xml');
      expect(svg.buffer.toString('utf8')).toContain('<svg');
    });
  });

  it('allows HTML and SVG file storage (display safety is not this module)', async () => {
    const dataDir = makeDataDir();
    const html = Buffer.from('<!doctype html><title>t</title>', 'utf8');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8');
    const htmlStored = await storePromptAttachmentBytes({
      dataDir,
      buffer: html,
      mime: 'text/html',
      validateImage: false,
    });
    const svgStored = await storePromptAttachmentBytes({
      dataDir,
      buffer: svg,
      mime: 'image/svg+xml',
      validateImage: false,
    });
    expect(htmlStored.sha256).toBe(sha256(html));
    expect(svgStored.sha256).toBe(sha256(svg));
    const htmlRead = await readPromptAttachmentBytes(dataDir, htmlStored.relativePath);
    const svgRead = await readPromptAttachmentBytes(dataDir, svgStored.relativePath);
    expect(htmlRead.buffer.equals(html)).toBe(true);
    expect(svgRead.buffer.equals(svg)).toBe(true);
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('completes short writes instead of leaving truncated objects', async () => {
    const dataDir = makeDataDir();
    const body = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz', 'utf8');
    const digest = sha256(body);
    const openOrig = fsp.open.bind(fsp);
    let shortWrote = false;
    vi.spyOn(fsp, 'open').mockImplementation(async (filePath, flags, mode) => {
      const handle = await openOrig(filePath, flags, mode);
      if (typeof filePath === 'string' && filePath.includes('.tmp-')) {
        const writeOrig = handle.write.bind(handle);
        handle.write = async (buffer, offset = 0, length = buffer.length - offset, position = null) => {
          if (!shortWrote && length > 1) {
            shortWrote = true;
            return writeOrig(buffer, offset, 1, position);
          }
          return writeOrig(buffer, offset, length, position);
        };
      }
      return handle;
    });

    const stored = await storePromptAttachmentBytes({
      dataDir,
      buffer: body,
      expectedSha256: digest,
      mime: 'text/plain',
      validateImage: false,
    });
    expect(shortWrote).toBe(true);
    expect(stored.size).toBe(body.length);
    const onDisk = await fsp.readFile(stored.absolutePath);
    expect(onDisk.equals(body)).toBe(true);
    expect(sha256(onDisk)).toBe(digest);
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('rejects store-root and hash-prefix symlink escape (NOFOLLOW alone is not enough)', async () => {
    const base = makeDataDir();
    const dataDir = path.join(base, 'data');
    const outside = path.join(base, 'outside-secret');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(outside, 'secret-leak');

    const digest = sha256(png);
    const prefix = digest.slice(0, 2);
    const storeRoot = promptAttachmentsRoot(dataDir);
    fs.mkdirSync(storeRoot, { recursive: true });
    const prefixPath = path.join(storeRoot, prefix);
    try {
      fs.symlinkSync(path.dirname(outside), prefixPath);
    } catch {
      await fsp.rm(base, { recursive: true, force: true });
      return;
    }

    await expect(storePromptAttachmentBytes({
      dataDir,
      buffer: png,
      expectedSha256: digest,
      mime: 'image/png',
      validateImage: true,
    })).rejects.toMatchObject({ code: 'attachment_unsafe_path' });

    // Must not have written the object through the escaped prefix.
    const escapedCandidate = path.join(path.dirname(outside), `${digest}.png`);
    expect(fs.existsSync(escapedCandidate)).toBe(false);

    await expect(readPromptAttachmentBytes(
      dataDir,
      relativeObjectPath(digest, 'image/png'),
    )).rejects.toMatchObject({
      code: expect.stringMatching(/attachment_unsafe_path|attachment_not_found/),
    });

    await fsp.rm(base, { recursive: true, force: true });
  });

  it('rejects corrupt existing object whose bytes do not match addressing hash', async () => {
    const dataDir = makeDataDir();
    const digest = sha256(png);
    const relativePath = relativeObjectPath(digest, 'image/png');
    const storeRoot = promptAttachmentsRoot(dataDir);
    const absolutePath = path.join(storeRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, Buffer.from('not-the-png-bytes'));

    await expect(storePromptAttachmentBytes({
      dataDir,
      buffer: png,
      expectedSha256: digest,
      mime: 'image/png',
      validateImage: true,
    })).rejects.toMatchObject({ code: 'attachment_hash_mismatch' });

    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('rejects read when on-disk bytes diverge from path addressing hash or expected hash/size', async () => {
    const dataDir = makeDataDir();
    const digest = sha256(png);
    const relativePath = relativeObjectPath(digest, 'image/png');
    const storeRoot = promptAttachmentsRoot(dataDir);
    const absolutePath = path.join(storeRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, Buffer.from('corrupt-payload'));

    await expect(readPromptAttachmentBytes(dataDir, relativePath)).rejects.toMatchObject({
      code: 'attachment_hash_mismatch',
    });

    // Plant correct bytes then fail optional caller expectations.
    fs.writeFileSync(absolutePath, png);
    await expect(readPromptAttachmentBytes(dataDir, relativePath, {
      expectedSha256: 'a'.repeat(64),
    })).rejects.toMatchObject({ code: 'attachment_hash_mismatch' });
    await expect(readPromptAttachmentBytes(dataDir, relativePath, {
      expectedSize: png.length + 1,
    })).rejects.toMatchObject({ code: 'PROMPT_ATTACHMENT_SIZE_MISMATCH' });

    const ok = await readPromptAttachmentBytes(dataDir, relativePath, {
      expectedSha256: digest,
      expectedSize: png.length,
    });
    expect(ok.buffer.equals(png)).toBe(true);

    await fsp.rm(dataDir, { recursive: true, force: true });
  });
});
