package com.openchamber.app;

import android.util.Base64;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;

/**
 * Thread-safe progressive byte queues for virtual image assets.
 * Opaque asset IDs only — never stores host paths, credentials, or tunnel keys.
 */
final class OpenChamberVirtualAssetStore {
    static final String SCHEME = "openchamber-asset";
    static final String URL_HOST = "v";

    static final long TTL_MILLIS = 120_000L;
    static final int MAX_CONCURRENT_ASSETS = 16;
    static final int MAX_ASSET_BYTES = 32 * 1024 * 1024;
    static final int MAX_QUEUED_BYTES = 4 * 1024 * 1024;
    static final long APPEND_WAIT_MILLIS = 15_000L;
    static final long READ_WAIT_MILLIS = 30_000L;

    private static final Pattern ASSET_ID = Pattern.compile("^[A-Za-z0-9_-]{8,80}$");
    /** image/* only — type/subtype form, optional +suffix, no parameters (matches Electron). */
    private static final Pattern IMAGE_MIME = Pattern.compile(
        "^image/[a-z0-9][a-z0-9!#$&\\-^_.+]*$",
        Pattern.CASE_INSENSITIVE
    );
    private static final ReentrantLock LOCK = new ReentrantLock();
    private static final Map<String, Asset> ASSETS = new HashMap<>();

    private OpenChamberVirtualAssetStore() {}

    static String urlFor(String assetId) {
        return SCHEME + "://" + URL_HOST + "/" + assetId;
    }

    static String extractAssetId(android.net.Uri uri) {
        if (uri == null) return null;
        String scheme = uri.getScheme();
        if (scheme == null || !SCHEME.equalsIgnoreCase(scheme)) return null;
        String host = uri.getHost();
        if (host == null || !URL_HOST.equalsIgnoreCase(host)) return null;
        String path = uri.getPath();
        if (path == null || path.isEmpty()) return null;
        String trimmed = path.startsWith("/") ? path.substring(1) : path;
        int slash = trimmed.indexOf('/');
        if (slash >= 0) trimmed = trimmed.substring(0, slash);
        if (trimmed.isEmpty()) return null;
        try {
            return java.net.URLDecoder.decode(trimmed, "UTF-8");
        } catch (Exception ignored) {
            return trimmed;
        }
    }

    /**
     * Normalize and validate image-only MIME (image/*, ≤128, no CR/LF/NUL, strict token).
     * @return lowercase normalized type, or null when rejected
     */
    static String normalizeImageMime(String mime) {
        if (mime == null) return null;
        String normalized = mime.trim().toLowerCase(java.util.Locale.ROOT);
        if (normalized.isEmpty() || normalized.length() > 128) return null;
        if (normalized.indexOf('\n') >= 0 || normalized.indexOf('\r') >= 0 || normalized.indexOf('\0') >= 0) {
            return null;
        }
        if (!normalized.startsWith("image/")) return null;
        if (!IMAGE_MIME.matcher(normalized).matches()) return null;
        return normalized;
    }

    static String create(String assetId, String mime) throws Exception {
        if (assetId == null || !ASSET_ID.matcher(assetId).matches()) {
            throw new IllegalArgumentException("A valid assetId is required.");
        }
        String normalizedMime = normalizeImageMime(mime);
        if (normalizedMime == null) {
            throw new IllegalArgumentException("A valid mime is required.");
        }
        LOCK.lock();
        try {
            pruneExpiredLocked(System.currentTimeMillis());
            if (ASSETS.containsKey(assetId)) {
                throw new IllegalStateException("assetId already exists.");
            }
            if (ASSETS.size() >= MAX_CONCURRENT_ASSETS) {
                throw new IllegalStateException("Virtual asset concurrency limit reached.");
            }
            ASSETS.put(assetId, new Asset(assetId, normalizedMime));
            return urlFor(assetId);
        } finally {
            LOCK.unlock();
        }
    }

    static void append(String assetId, String base64Chunk) throws Exception {
        byte[] data = decodeBase64(base64Chunk);
        if (data.length == 0) return;

        long deadline = System.currentTimeMillis() + APPEND_WAIT_MILLIS;
        LOCK.lock();
        try {
            while (true) {
                pruneExpiredLocked(System.currentTimeMillis());
                Asset asset = ASSETS.get(assetId);
                if (asset == null) throw new IllegalStateException("Unknown assetId.");
                if (asset.cancelled) throw new IllegalStateException("Asset was cancelled.");
                if (asset.finished) throw new IllegalStateException("Asset already finished.");
                if ((long) asset.totalBytes + data.length > MAX_ASSET_BYTES) {
                    throw new IllegalStateException("Asset exceeds maximum size.");
                }
                if (asset.queuedBytes + data.length <= MAX_QUEUED_BYTES) {
                    asset.chunks.addLast(data);
                    asset.queuedBytes += data.length;
                    asset.totalBytes += data.length;
                    asset.lastActivity = System.currentTimeMillis();
                    asset.condition.signalAll();
                    return;
                }
                long remaining = deadline - System.currentTimeMillis();
                if (remaining <= 0) {
                    throw new IllegalStateException("Asset queue backpressure timeout.");
                }
                asset.condition.await(remaining, TimeUnit.MILLISECONDS);
            }
        } finally {
            LOCK.unlock();
        }
    }

    static void finish(String assetId) throws Exception {
        LOCK.lock();
        try {
            Asset asset = ASSETS.get(assetId);
            if (asset == null) throw new IllegalStateException("Unknown assetId.");
            if (asset.cancelled) throw new IllegalStateException("Asset was cancelled.");
            asset.finished = true;
            asset.lastActivity = System.currentTimeMillis();
            asset.condition.signalAll();
        } finally {
            LOCK.unlock();
        }
    }

    static void cancel(String assetId) {
        LOCK.lock();
        try {
            Asset asset = ASSETS.get(assetId);
            if (asset == null) return;
            asset.cancelled = true;
            asset.finished = true;
            asset.chunks.clear();
            asset.queuedBytes = 0;
            asset.condition.signalAll();
            if (asset.activeReaders == 0) {
                ASSETS.remove(assetId);
            }
        } finally {
            LOCK.unlock();
        }
    }

    /**
     * Blocking InputStream that yields progressive bytes from the asset queue.
     * One consumer per asset — a second open is rejected so the shared queue is not sharded.
     */
    static InputStream openStream(String assetId) throws IOException {
        LOCK.lock();
        try {
            pruneExpiredLocked(System.currentTimeMillis());
            Asset asset = ASSETS.get(assetId);
            if (asset == null || asset.cancelled) {
                throw new IOException("Unknown or cancelled assetId.");
            }
            if (asset.activeReaders > 0) {
                throw new IOException("Asset already has an active reader.");
            }
            asset.activeReaders += 1;
            asset.lastActivity = System.currentTimeMillis();
            return new AssetInputStream(assetId, asset);
        } finally {
            LOCK.unlock();
        }
    }

    static String mimeOf(String assetId) {
        LOCK.lock();
        try {
            Asset asset = ASSETS.get(assetId);
            return asset != null ? asset.mime : null;
        } finally {
            LOCK.unlock();
        }
    }

    private static void releaseReader(String assetId) {
        LOCK.lock();
        try {
            Asset asset = ASSETS.get(assetId);
            if (asset == null) return;
            asset.activeReaders = Math.max(0, asset.activeReaders - 1);
            if ((asset.finished || asset.cancelled) && asset.activeReaders == 0) {
                ASSETS.remove(assetId);
            }
        } finally {
            LOCK.unlock();
        }
    }

    private static void pruneExpiredLocked(long now) {
        Iterator<Map.Entry<String, Asset>> it = ASSETS.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, Asset> entry = it.next();
            Asset asset = entry.getValue();
            if (now - asset.lastActivity <= TTL_MILLIS) continue;
            asset.cancelled = true;
            asset.finished = true;
            asset.chunks.clear();
            asset.queuedBytes = 0;
            asset.condition.signalAll();
            if (asset.activeReaders == 0) {
                it.remove();
            }
        }
    }

    private static byte[] decodeBase64(String chunk) {
        if (chunk == null) throw new IllegalArgumentException("Invalid base64 chunk.");
        String trimmed = chunk.trim();
        if (trimmed.isEmpty()) return new byte[0];
        String normalized = trimmed.replace('-', '+').replace('_', '/');
        int pad = normalized.length() % 4;
        if (pad != 0) {
            StringBuilder builder = new StringBuilder(normalized);
            for (int i = 0; i < 4 - pad; i++) builder.append('=');
            normalized = builder.toString();
        }
        try {
            return Base64.decode(normalized, Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("Invalid base64 chunk.", error);
        }
    }

    private static final class Asset {
        final String assetId;
        final String mime;
        final ArrayDeque<byte[]> chunks = new ArrayDeque<>();
        final Condition condition = LOCK.newCondition();
        long lastActivity = System.currentTimeMillis();
        boolean finished = false;
        boolean cancelled = false;
        int totalBytes = 0;
        int queuedBytes = 0;
        int activeReaders = 0;

        Asset(String assetId, String mime) {
            this.assetId = assetId;
            this.mime = mime;
        }
    }

    /**
     * Thread-safe blocking InputStream. WebView may read this off the UI thread;
     * {@link #read} waits on the asset condition when the queue is empty.
     */
    private static final class AssetInputStream extends InputStream {
        private final String assetId;
        private final Asset asset;
        private byte[] current;
        private int offset;
        private boolean closed;

        AssetInputStream(String assetId, Asset asset) {
            this.assetId = assetId;
            this.asset = asset;
        }

        @Override
        public int read() throws IOException {
            byte[] one = new byte[1];
            int n = read(one, 0, 1);
            return n <= 0 ? -1 : (one[0] & 0xff);
        }

        @Override
        public int read(byte[] buffer, int off, int len) throws IOException {
            if (closed) throw new IOException("Stream closed.");
            if (buffer == null) throw new NullPointerException();
            if (off < 0 || len < 0 || off + len > buffer.length) {
                throw new IndexOutOfBoundsException();
            }
            if (len == 0) return 0;

            LOCK.lock();
            try {
                long deadline = System.currentTimeMillis() + READ_WAIT_MILLIS;
                while (true) {
                    if (closed || asset.cancelled) {
                        return -1;
                    }
                    if (current != null && offset < current.length) {
                        int available = current.length - offset;
                        int copy = Math.min(available, len);
                        System.arraycopy(current, offset, buffer, off, copy);
                        offset += copy;
                        if (offset >= current.length) {
                            current = null;
                            offset = 0;
                        }
                        asset.lastActivity = System.currentTimeMillis();
                        // Drain reduces queued bytes for backpressure.
                        asset.condition.signalAll();
                        return copy;
                    }
                    if (!asset.chunks.isEmpty()) {
                        current = asset.chunks.removeFirst();
                        offset = 0;
                        asset.queuedBytes = Math.max(0, asset.queuedBytes - current.length);
                        asset.lastActivity = System.currentTimeMillis();
                        asset.condition.signalAll();
                        continue;
                    }
                    if (asset.finished) {
                        return -1;
                    }
                    long remaining = deadline - System.currentTimeMillis();
                    if (remaining <= 0) {
                        // Idle timeout: treat as end so WebView does not hang forever.
                        return -1;
                    }
                    try {
                        asset.condition.await(remaining, TimeUnit.MILLISECONDS);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        throw new IOException("Interrupted while reading virtual asset.", interrupted);
                    }
                }
            } finally {
                LOCK.unlock();
            }
        }

        @Override
        public void close() {
            if (closed) return;
            closed = true;
            LOCK.lock();
            try {
                current = null;
                offset = 0;
                asset.condition.signalAll();
            } finally {
                LOCK.unlock();
            }
            releaseReader(assetId);
        }
    }
}
