/**
 * Content-addressed prompt attachment storage under dataDir/prompt-attachments.
 * Shared by Chat prompt uploads and Assistant contact attachments.
 * Never treats client-supplied filesystem paths as authorization.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';

export const MAX_PROMPT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const PROMPT_ATTACHMENT_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
export const PROMPT_ATTACHMENT_SHA256 = /^[a-f0-9]{64}$/;
export const PROMPT_ATTACHMENT_MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

/** Passiveive image types safe for Content-Disposition: inline. */
export const SAFE_INLINE_IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
  'image/heic',
  'image/heif',
]);

const OPEN_NOFOLLOW = fsConstants.O_NOFOLLOW || 0;

const fail = (code, message) => {
  const error = new Error(message || code);
  error.code = code;
  throw error;
};

const isInsideRoot = (root, candidate) => {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  return target === base || target.startsWith(`${base}${path.sep}`);
};

/** Extension from MIME only — never trust client filename for object path. */
export const promptAttachmentExtension = (mime) => {
  const lowerMime = typeof mime === 'string' ? mime.toLowerCase().split(';', 1)[0].trim() : '';
  if (lowerMime === 'image/jpeg' || lowerMime === 'image/jpg') return '.jpg';
  if (lowerMime === 'image/png') return '.png';
  if (lowerMime === 'image/gif') return '.gif';
  if (lowerMime === 'image/webp') return '.webp';
  if (lowerMime === 'image/heic') return '.heic';
  if (lowerMime === 'image/heif') return '.heif';
  if (lowerMime === 'image/avif') return '.avif';
  if (lowerMime === 'image/bmp') return '.bmp';
  if (lowerMime === 'text/plain') return '.txt';
  if (lowerMime === 'application/pdf') return '.pdf';
  // SVG/HTML never get a "document" extension that browsers might execute inline by path alone.
  return '.bin';
};

export function isSafeInlineImageMime(mime) {
  const lower = typeof mime === 'string' ? mime.toLowerCase().split(';', 1)[0].trim() : '';
  return SAFE_INLINE_IMAGE_MIME.has(lower);
}

/** Magic-byte checks for common image types; non-image MIME skips. */
export function assertImageContentMatchesMime(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    fail('attachment_empty', 'Attachment body is empty');
  }
  const lower = typeof mime === 'string' ? mime.toLowerCase().split(';', 1)[0].trim() : '';
  if (!lower.startsWith('image/')) return;
  // SVG/HTML storage is allowed at the shared writer; raster magic checks only.
  if (lower === 'image/svg+xml' || lower.includes('html')) return;
  const b = buffer;
  const isPng = b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const isJpeg = b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const isGif = b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;
  const isWebp = b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
  const isBmp = b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d;
  if (lower === 'image/png' && !isPng) fail('attachment_mime_mismatch', 'PNG signature mismatch');
  if ((lower === 'image/jpeg' || lower === 'image/jpg') && !isJpeg) fail('attachment_mime_mismatch', 'JPEG signature mismatch');
  if (lower === 'image/gif' && !isGif) fail('attachment_mime_mismatch', 'GIF signature mismatch');
  if (lower === 'image/webp' && !isWebp) fail('attachment_mime_mismatch', 'WEBP signature mismatch');
  if (lower === 'image/bmp' && !isBmp) fail('attachment_mime_mismatch', 'BMP signature mismatch');
}

export async function collectRequestBytes(req, { expectedSize, maxBytes = MAX_PROMPT_ATTACHMENT_BYTES, signal } = {}) {
  // Prefer raw Buffer body when express already buffered (should not happen for exempt PUTs).
  if (Buffer.isBuffer(req?.body)) {
    const size = req.body.length;
    if (size > maxBytes) fail('PROMPT_ATTACHMENT_TOO_LARGE', 'Attachment too large');
    if (expectedSize !== undefined && size !== expectedSize) {
      fail('PROMPT_ATTACHMENT_SIZE_MISMATCH', 'Attachment size mismatch');
    }
    return { buffer: req.body, size };
  }
  if (typeof req?.[Symbol.asyncIterator] !== 'function') {
    fail('attachment_invalid_body', 'Attachment stream required');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    if (signal?.aborted) fail('PROMPT_ATTACHMENT_ABORTED', 'Upload aborted');
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) fail('PROMPT_ATTACHMENT_TOO_LARGE', 'Attachment too large');
    chunks.push(bytes);
  }
  if (expectedSize !== undefined && size !== expectedSize) {
    fail('PROMPT_ATTACHMENT_SIZE_MISMATCH', 'Attachment size mismatch');
  }
  return { buffer: Buffer.concat(chunks, size), size };
}

export function promptAttachmentsRoot(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    fail('attachment_store_unavailable', 'Prompt attachment storage is unavailable');
  }
  return path.resolve(dataDir.trim(), 'prompt-attachments');
}

/**
 * Ensure store root exists and return canonical real path (no symlink escape).
 * Trust anchor for all subsequent object path checks.
 */
export async function ensureCanonicalStoreRoot(dataDir) {
  const root = promptAttachmentsRoot(dataDir);
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });

  let rootLstat;
  try {
    rootLstat = await fsp.lstat(root);
  } catch (error) {
    fail('attachment_store_unavailable', 'Prompt attachment storage is unavailable');
  }
  if (rootLstat.isSymbolicLink()) {
    fail('attachment_unsafe_path', 'Unsafe attachment path');
  }
  if (!rootLstat.isDirectory()) {
    fail('attachment_store_unavailable', 'Prompt attachment storage is unavailable');
  }

  let realRoot;
  try {
    realRoot = await fsp.realpath(root);
  } catch {
    fail('attachment_store_unavailable', 'Prompt attachment storage is unavailable');
  }

  // Trust anchor is always realpath(root). Intermediate path components may legally
  // realpath-differ on some platforms (e.g. macOS /var → /private/var). The leaf
  // "prompt-attachments" entry itself must not be a symlink (checked above); all
  // later object IO must use this realRoot and reject prefix/leaf symlink escapes.
  if (typeof realRoot !== 'string' || !realRoot) {
    fail('attachment_store_unavailable', 'Prompt attachment storage is unavailable');
  }

  const realStat = await fsp.stat(realRoot);
  if (!realStat.isDirectory()) {
    fail('attachment_store_unavailable', 'Prompt attachment storage is unavailable');
  }
  return realRoot;
}

/** Relative path under store root: aa/aaa…sha.ext — MIME-driven extension only. */
export function relativeObjectPath(sha256, mime) {
  if (!PROMPT_ATTACHMENT_SHA256.test(sha256)) fail('attachment_invalid_hash', 'Invalid attachment digest');
  const ext = promptAttachmentExtension(mime);
  return path.posix.join(sha256.slice(0, 2), `${sha256}${ext}`);
}

export function absoluteObjectPath(dataDir, relativePath, { canonicalRoot = null } = {}) {
  const root = canonicalRoot || promptAttachmentsRoot(dataDir);
  const rel = typeof relativePath === 'string' ? relativePath.replace(/\\/g, '/').replace(/^\/+/, '') : '';
  if (!rel || rel.includes('..') || path.isAbsolute(rel) || rel.includes('\0')) {
    fail('attachment_unsafe_path', 'Unsafe attachment path');
  }
  if (!/^[a-f0-9]{2}\/[a-f0-9]{64}\.[a-z0-9.]+$/i.test(rel)) {
    fail('attachment_unsafe_path', 'Unsafe attachment path');
  }
  const absolute = path.resolve(root, rel);
  if (!isInsideRoot(root, absolute)) {
    fail('attachment_unsafe_path', 'Unsafe attachment path');
  }
  return absolute;
}

/** Addressing digest embedded in a validated relative object path. */
function addressingHashFromRelativePath(relativePath) {
  const rel = typeof relativePath === 'string' ? relativePath.replace(/\\/g, '/') : '';
  const match = /^([a-f0-9]{2})\/([a-f0-9]{64})\.[a-z0-9.]+$/i.exec(rel);
  if (!match || match[1].toLowerCase() !== match[2].slice(0, 2).toLowerCase()) {
    fail('attachment_unsafe_path', 'Unsafe attachment path');
  }
  return match[2].toLowerCase();
}

/**
 * Ensure hash-prefix directory exists under canonical root without following symlinks.
 * O_NOFOLLOW only protects the final open; prefix dirs must be checked explicitly.
 */
async function ensureTrustedPrefixDir(canonicalRoot, sha256) {
  const prefix = sha256.slice(0, 2).toLowerCase();
  const dir = path.join(canonicalRoot, prefix);

  let st;
  try {
    st = await fsp.lstat(dir);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await fsp.mkdir(dir, { mode: 0o700 });
    st = await fsp.lstat(dir);
  }

  if (st.isSymbolicLink()) {
    fail('attachment_unsafe_path', 'Unsafe attachment path');
  }
  if (!st.isDirectory()) {
    fail('attachment_unsafe_path', 'Unsafe attachment path');
  }

  let realDir;
  try {
    realDir = await fsp.realpath(dir);
  } catch {
    fail('attachment_unsafe_path', 'Unsafe attachment path');
  }
  // canonicalRoot is already realpath'd; prefix realpath must stay inside it.
  // Do not require realDir === dir: platform path aliases (macOS /var vs /private/var) differ.
  if (!isInsideRoot(canonicalRoot, realDir) || path.basename(realDir).toLowerCase() !== prefix) {
    fail('attachment_unsafe_path', 'Unsafe attachment path');
  }
  return realDir;
}

/**
 * Resolve a trusted final object path: validate relative form, trusted prefix, no symlink parents.
 */
async function resolveTrustedObjectPath(canonicalRoot, relativePath) {
  const rel = typeof relativePath === 'string' ? relativePath.replace(/\\/g, '/').replace(/^\/+/, '') : '';
  if (!rel || rel.includes('..') || path.isAbsolute(rel) || rel.includes('\0')) {
    fail('attachment_unsafe_path', 'Unsafe attachment path');
  }
  if (!/^[a-f0-9]{2}\/[a-f0-9]{64}\.[a-z0-9.]+$/i.test(rel)) {
    fail('attachment_unsafe_path', 'Unsafe attachment path');
  }
  const addressingHash = addressingHashFromRelativePath(rel);
  const realPrefix = await ensureTrustedPrefixDir(canonicalRoot, addressingHash);
  const baseName = path.posix.basename(rel);
  if (!baseName || baseName !== rel.split('/').pop() || baseName.includes('/') || baseName.includes('\\')) {
    fail('attachment_unsafe_path', 'Unsafe attachment path');
  }
  const absolutePath = path.join(realPrefix, baseName);
  if (!isInsideRoot(canonicalRoot, absolutePath)) {
    fail('attachment_unsafe_path', 'Unsafe attachment path');
  }

  // Final leaf must not be a symlink (when present).
  try {
    const leaf = await fsp.lstat(absolutePath);
    if (leaf.isSymbolicLink()) {
      fail('attachment_unsafe_path', 'Unsafe attachment path');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  return { absolutePath, addressingHash, prefixDir: realPrefix };
}

async function hashFileLimited(fd, maxBytes) {
  const hash = createHash('sha256');
  const buf = Buffer.alloc(64 * 1024);
  let total = 0;
  for (;;) {
    const { bytesRead } = await fd.read(buf, 0, buf.length, total);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) fail('PROMPT_ATTACHMENT_TOO_LARGE', 'Attachment too large');
    hash.update(buf.subarray(0, bytesRead));
  }
  return { digest: hash.digest('hex'), size: total };
}

/** Write the full buffer; a single fd.write may short-write. */
async function writeAllBytes(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await fd.write(buffer, offset, buffer.length - offset, offset);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) {
      fail('attachment_write_failed', 'Short write while storing attachment');
    }
    offset += bytesWritten;
  }
}

/**
 * Directory fsync after rename for durability. Platforms that reject dir sync are skipped explicitly.
 */
async function fsyncDirectory(dirPath) {
  let dirFd;
  try {
    dirFd = await fsp.open(dirPath, fsConstants.O_RDONLY);
  } catch (error) {
    // Windows and some sandbox environments cannot open directories for fsync.
    if (error?.code === 'EISDIR' || error?.code === 'EPERM' || error?.code === 'EINVAL' || error?.code === 'ENOTDIR') {
      return;
    }
    throw error;
  }
  try {
    await dirFd.sync();
  } catch (error) {
    if (error?.code === 'EINVAL' || error?.code === 'ENOTSUP' || error?.code === 'EPERM' || error?.code === 'EISDIR') {
      return;
    }
    throw error;
  } finally {
    await dirFd.close().catch(() => {});
  }
}

async function openReadonlyNoFollow(absolutePath) {
  try {
    return await fsp.open(absolutePath, fsConstants.O_RDONLY | OPEN_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ELOOP' || error?.code === 'EPERM') {
      fail('attachment_unsafe_path', 'Unsafe attachment path');
    }
    throw error;
  }
}

/**
 * Write buffer to content-addressed path. Idempotent on same digest after hash verify.
 * Durable: complete write loop, post-write size/hash verify, fsync temp, rename, parent dir fsync.
 * Existing files are re-hashed before reuse; content must match addressing hash.
 */
export async function storePromptAttachmentBytes({
  dataDir,
  buffer,
  expectedSha256,
  mime,
  filename,
  maxBytes = MAX_PROMPT_ATTACHMENT_BYTES,
  validateImage = true,
} = {}) {
  if (!Buffer.isBuffer(buffer)) fail('attachment_invalid_body', 'Attachment body required');
  if (buffer.length > maxBytes) fail('PROMPT_ATTACHMENT_TOO_LARGE', 'Attachment too large');
  if (buffer.length === 0) fail('attachment_empty', 'Attachment body is empty');
  const mimeType = typeof mime === 'string' && mime.trim()
    ? mime.split(';', 1)[0].trim()
    : 'application/octet-stream';
  if (!PROMPT_ATTACHMENT_MIME.test(mimeType)) fail('attachment_invalid_mime', 'Attachment MIME type is invalid');
  // HTML/SVG are ordinary chat source uploads; HTTP display safety is owned elsewhere.
  if (validateImage) assertImageContentMatchesMime(buffer, mimeType);

  const digest = createHash('sha256').update(buffer).digest('hex');
  if (expectedSha256 && !PROMPT_ATTACHMENT_SHA256.test(expectedSha256)) {
    fail('attachment_invalid_hash', 'Attachment digest is required');
  }
  if (expectedSha256 && expectedSha256 !== digest) {
    fail('attachment_hash_mismatch', 'Attachment digest mismatch');
  }

  const root = await ensureCanonicalStoreRoot(dataDir);
  const relativePath = relativeObjectPath(digest, mimeType);
  const { absolutePath, prefixDir } = await resolveTrustedObjectPath(root, relativePath);

  // Existing object: open nofollow, fstat, re-hash, only reuse if digest+size match addressing hash.
  try {
    const existingFd = await openReadonlyNoFollow(absolutePath);
    try {
      const st = await existingFd.stat();
      if (!st.isFile()) fail('attachment_unsafe_path', 'Unsafe attachment path');
      if (st.size !== buffer.length) {
        fail('attachment_hash_mismatch', 'Existing attachment object digest mismatch');
      }
      if (st.size > maxBytes) fail('PROMPT_ATTACHMENT_TOO_LARGE', 'Attachment too large');
      const { digest: existingDigest, size: existingSize } = await hashFileLimited(existingFd, maxBytes);
      if (existingDigest !== digest || existingSize !== buffer.length || existingDigest !== addressingHashFromRelativePath(relativePath)) {
        fail('attachment_hash_mismatch', 'Existing attachment object digest mismatch');
      }
      return {
        sha256: digest,
        size: buffer.length,
        mime: mimeType,
        relativePath,
        absolutePath,
        filename: typeof filename === 'string' && filename.trim() ? filename.trim().slice(0, 512) : undefined,
      };
    } finally {
      await existingFd.close().catch(() => {});
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // fall through to write
    } else if (error?.code === 'ELOOP' || error?.code === 'EPERM') {
      fail('attachment_unsafe_path', 'Unsafe attachment path');
    } else if (typeof error?.code === 'string' && (
      error.code.startsWith('attachment')
      || error.code === 'PROMPT_ATTACHMENT_TOO_LARGE'
      || error.code === 'PROMPT_ATTACHMENT_SIZE_MISMATCH'
    )) {
      throw error;
    } else {
      throw error;
    }
  }

  const tmpPath = path.join(
    prefixDir,
    `.tmp-${path.basename(absolutePath)}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    // O_RDWR so we can re-read for size/hash verify after write; O_NOFOLLOW rejects symlink tmp.
    const fd = await fsp.open(
      tmpPath,
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_TRUNC | OPEN_NOFOLLOW,
      0o600,
    );
    try {
      await writeAllBytes(fd, buffer);
      await fd.sync();
      const st = await fd.stat();
      if (st.size !== buffer.length) {
        fail('attachment_write_failed', 'Attachment size mismatch after write');
      }
      const { digest: writtenDigest, size: writtenSize } = await hashFileLimited(fd, maxBytes);
      if (writtenDigest !== digest || writtenSize !== buffer.length) {
        fail('attachment_hash_mismatch', 'Attachment digest mismatch after write');
      }
    } finally {
      await fd.close().catch(() => {});
    }
    await fsp.rename(tmpPath, absolutePath);
    await fsyncDirectory(prefixDir);
  } catch (error) {
    await fsp.unlink(tmpPath).catch(() => {});
    if (error && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')) {
      // Lost race to another writer — verify winner.
      return storePromptAttachmentBytes({
        dataDir,
        buffer,
        expectedSha256: digest,
        mime: mimeType,
        filename,
        maxBytes,
        validateImage: false,
      });
    }
    throw error;
  }

  // Post-rename verify through trusted open (size + addressing hash).
  const verifyFd = await openReadonlyNoFollow(absolutePath);
  try {
    const st = await verifyFd.stat();
    if (!st.isFile() || st.size !== buffer.length) {
      fail('attachment_write_failed', 'Attachment size mismatch after rename');
    }
    const { digest: finalDigest, size: finalSize } = await hashFileLimited(verifyFd, maxBytes);
    if (finalDigest !== digest || finalSize !== buffer.length) {
      fail('attachment_hash_mismatch', 'Attachment digest mismatch after rename');
    }
  } finally {
    await verifyFd.close().catch(() => {});
  }

  return {
    sha256: digest,
    size: buffer.length,
    mime: mimeType,
    relativePath,
    absolutePath,
    filename: typeof filename === 'string' && filename.trim() ? filename.trim().slice(0, 512) : undefined,
  };
}

/**
 * Read attachment bytes with NOFOLLOW + bounded read.
 * Optional expectedSize / expectedSha256 for callers; on-disk content must always match path addressing hash.
 */
export async function readPromptAttachmentBytes(
  dataDir,
  relativePath,
  {
    maxBytes = MAX_PROMPT_ATTACHMENT_BYTES,
    expectedSize,
    expectedSha256,
  } = {},
) {
  const root = await ensureCanonicalStoreRoot(dataDir);
  const { absolutePath, addressingHash } = await resolveTrustedObjectPath(root, relativePath);

  if (expectedSha256 !== undefined) {
    if (typeof expectedSha256 !== 'string' || !PROMPT_ATTACHMENT_SHA256.test(expectedSha256)) {
      fail('attachment_invalid_hash', 'Invalid attachment digest');
    }
  }

  let fd;
  try {
    fd = await openReadonlyNoFollow(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT') fail('attachment_not_found', 'Attachment not found');
    if (error?.code === 'ELOOP') fail('attachment_unsafe_path', 'Unsafe attachment path');
    throw error;
  }
  try {
    const st = await fd.stat();
    if (!st.isFile()) fail('attachment_unsafe_path', 'Unsafe attachment path');
    if (st.size > maxBytes) fail('PROMPT_ATTACHMENT_TOO_LARGE', 'Attachment too large');
    if (expectedSize !== undefined && st.size !== expectedSize) {
      fail('PROMPT_ATTACHMENT_SIZE_MISMATCH', 'Attachment size mismatch');
    }

    const buffer = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const { bytesRead } = await fd.read(buffer, offset, Math.min(64 * 1024, st.size - offset), offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== st.size) {
      fail('attachment_read_failed', 'Attachment read truncated');
    }

    const digest = createHash('sha256').update(buffer).digest('hex');
    if (digest !== addressingHash) {
      fail('attachment_hash_mismatch', 'Attachment digest mismatch');
    }
    if (expectedSha256 && expectedSha256 !== digest) {
      fail('attachment_hash_mismatch', 'Attachment digest mismatch');
    }
    if (expectedSize !== undefined && offset !== expectedSize) {
      fail('PROMPT_ATTACHMENT_SIZE_MISMATCH', 'Attachment size mismatch');
    }

    return { buffer, size: offset, absolutePath };
  } finally {
    await fd.close().catch(() => {});
  }
}

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Sync exists check for migration dry probes. */
export function promptAttachmentFileExistsSync(dataDir, relativePath) {
  try {
    const root = promptAttachmentsRoot(dataDir);
    const absolutePath = absoluteObjectPath(dataDir, relativePath, { canonicalRoot: root });
    // Walk components with lstat so prefix symlinks cannot report a false positive.
    const rel = path.relative(root, absolutePath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    let current = root;
    const parts = rel.split(path.sep);
    for (let i = 0; i < parts.length; i += 1) {
      current = path.join(current, parts[i]);
      const st = fs.lstatSync(current);
      if (st.isSymbolicLink()) return false;
      if (i < parts.length - 1) {
        if (!st.isDirectory()) return false;
      } else if (!st.isFile()) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Strict percent-decode for data-URL payload (non-base64).
 * Literal '+' is preserved (data URLs are not form-urlencoded).
 */
function decodeDataUrlPercentPayload(payload) {
  if (typeof payload !== 'string') fail('validation_error', 'Invalid data URL payload');
  // Reject bare % that is not a valid %HH sequence before decodeURIComponent.
  if (/%(?![0-9A-Fa-f]{2})/.test(payload)) {
    fail('validation_error', 'Invalid data URL payload');
  }
  try {
    return Buffer.from(decodeURIComponent(payload), 'utf8');
  } catch {
    fail('validation_error', 'Invalid data URL payload');
  }
}

/**
 * Strict base64 decode: alphabet + padding length, round-trip check.
 */
function decodeDataUrlBase64Payload(payload) {
  const cleaned = payload.replace(/\s+/g, '');
  if (!cleaned) fail('validation_error', 'Invalid data URL base64');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
    fail('validation_error', 'Invalid data URL base64');
  }
  if (cleaned.length % 4 === 1) {
    fail('validation_error', 'Invalid data URL base64');
  }
  const padMatch = cleaned.match(/=+$/);
  if (padMatch && padMatch[0].length > 2) {
    fail('validation_error', 'Invalid data URL base64');
  }
  if (/=/.test(cleaned.replace(/=+$/, ''))) {
    fail('validation_error', 'Invalid data URL base64');
  }
  // Normalize missing padding for decode, then round-trip against canonical form.
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
  let buffer;
  try {
    buffer = Buffer.from(padded, 'base64');
  } catch {
    fail('validation_error', 'Invalid data URL base64');
  }
  if (cleaned && buffer.length === 0) fail('validation_error', 'Invalid data URL base64');
  const roundTrip = buffer.toString('base64');
  const normalizedInput = padded;
  if (roundTrip !== normalizedInput) {
    // Allow optional padding on input: compare without trailing '='.
    if (roundTrip.replace(/=+$/, '') !== cleaned.replace(/=+$/, '')) {
      fail('validation_error', 'Invalid data URL base64');
    }
    // If input had padding, it must match canonical padding exactly.
    if (cleaned.includes('=') && roundTrip !== cleaned && roundTrip !== padded) {
      fail('validation_error', 'Invalid data URL base64');
    }
  }
  return buffer;
}

/**
 * Strict data-URL decode.
 * @param {'admission'|'migration'} mode — admission enforces 25MiB; migration allows larger historical.
 */
export function decodeDataUrlStrict(url, { mode = 'admission', maxBytes = MAX_PROMPT_ATTACHMENT_BYTES } = {}) {
  if (typeof url !== 'string' || !url.startsWith('data:')) {
    fail('validation_error', 'Invalid data URL');
  }
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i.exec(url);
  if (!match) fail('validation_error', 'Invalid data URL');
  const mime = (match[1] || 'application/octet-stream').trim().toLowerCase();
  if (!PROMPT_ATTACHMENT_MIME.test(mime)) fail('attachment_invalid_mime', 'Attachment MIME type is invalid');
  // HTML/SVG allowed for ordinary chat source uploads; display safety is elsewhere.
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || '';
  let buffer;
  if (isBase64) {
    buffer = decodeDataUrlBase64Payload(payload);
  } else {
    buffer = decodeDataUrlPercentPayload(payload);
  }
  const limit = mode === 'migration' ? Math.max(maxBytes, buffer.length) : maxBytes;
  if (buffer.length > limit) fail('PROMPT_ATTACHMENT_TOO_LARGE', 'Attachment too large');
  if (buffer.length === 0) fail('attachment_empty', 'Attachment body is empty');
  return { buffer, mime, size: buffer.length };
}
