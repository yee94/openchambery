package com.openchamber.app;

import android.util.Base64;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Iterator;
import java.util.concurrent.atomic.AtomicBoolean;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.json.JSONObject;

/** One notification-only stream. No WebView, transcript sync, or polling. */
final class NotificationConnection implements AutoCloseable {
    static final String PATH = "/api/notifications/native-stream";
    interface Listener {
        void event(String id, JSONObject event);
        void failed(boolean permanent);
    }
    private final AtomicBoolean closed = new AtomicBoolean();
    private final Listener listener;
    private final NotificationSseParser parser;
    private final JSONObject headers;
    private Call call;
    private WebSocket socket;
    private NotificationRelayCrypto crypto;
    private boolean established;
    private boolean accepted;
    volatile long lastReceived = android.os.SystemClock.elapsedRealtime();

    NotificationConnection(OkHttpClient client, JSONObject config, boolean useRelay, String cursor, Listener listener) throws Exception {
        this.listener = listener;
        headers = new JSONObject(config.getJSONObject("headers").toString());
        headers.put("Accept", "text/event-stream");
        if (!cursor.isEmpty()) headers.put("Last-Event-ID", cursor);
        parser = new NotificationSseParser((id, data) -> {
            if (!closed.get()) listener.event(id, new JSONObject(data));
        });
        if (useRelay) openRelay(client, config.getJSONObject("relay"));
        else {
            JSONObject fallback = config.optJSONObject("relay");
            if (fallback == null) openDirect(client, config.getString("baseUrl"));
            else verifyDirectIdentity(client, config.getString("baseUrl"), fallback.getString("serverId"));
        }
    }

    private void verifyDirectIdentity(OkHttpClient client, String baseUrl, String serverId) {
        // A LAN address may have been reassigned while the WebView was suspended.
        // Verify the pinned host identity before sending the paired bearer to it.
        call = client.newCall(new Request.Builder().url(HttpUrl.get(baseUrl).resolve("/health")).build());
        call.timeout().timeout(8, java.util.concurrent.TimeUnit.SECONDS);
        call.enqueue(new Callback() {
            @Override public void onFailure(Call ignored, java.io.IOException error) { fail(false); }
            @Override public void onResponse(Call ignored, Response response) {
                try (Response owned = response) {
                    if (closed.get()) return;
                    if (owned.code() != 200 || owned.body() == null) { fail(false); return; }
                    if (owned.body().source().request(8193)) { fail(false); return; }
                    String body = owned.body().source().readUtf8();
                    if (!serverId.equals(new JSONObject(body).optString("serverId"))) { fail(true); return; }
                    openDirect(client, baseUrl);
                } catch (Exception ignoredError) { fail(false); }
            }
        });
    }

    private void openDirect(OkHttpClient client, String baseUrl) {
        if (closed.get()) return;
        HttpUrl base = HttpUrl.get(baseUrl);
        Request.Builder request = new Request.Builder().url(base.resolve(PATH));
        Iterator<String> keys = headers.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            request.header(key, headers.optString(key));
        }
        call = client.newCall(request.build());
        call.enqueue(new Callback() {
            @Override public void onFailure(Call ignored, java.io.IOException error) { fail(false); }
            @Override public void onResponse(Call ignored, Response response) {
                try (Response owned = response) {
                    if (!validResponse(owned.code(), owned.header("Content-Type", ""))) return;
                    if (owned.body() == null) { fail(false); return; }
                    byte[] buffer = new byte[4096];
                    InputStream input = owned.body().byteStream();
                    int count;
                    while (!closed.get() && (count = input.read(buffer)) != -1) {
                        lastReceived = android.os.SystemClock.elapsedRealtime();
                        parser.accept(Arrays.copyOf(buffer, count));
                    }
                    fail(false);
                } catch (Exception error) { fail(false); }
            }
        });
    }

    private static byte[] decode(String value) {
        return Base64.decode(value, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }
    private static String encode(byte[] value) {
        return Base64.encodeToString(value, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private void openRelay(OkHttpClient client, JSONObject relay) throws Exception {
        JSONObject key = relay.getJSONObject("hostEncPubJwk");
        if (!"EC".equals(key.optString("kty")) || !"P-256".equals(key.optString("crv"))) {
            throw new IllegalArgumentException("Invalid relay key");
        }
        crypto = new NotificationRelayCrypto(decode(key.getString("x")), decode(key.getString("y")));
        String rawUrl = relay.getString("relayUrl");
        HttpUrl.Builder url = HttpUrl.get(rawUrl.replaceFirst("^ws:", "http:").replaceFirst("^wss:", "https:")).newBuilder()
            .setQueryParameter("v", "1").setQueryParameter("role", "client")
            .setQueryParameter("serverId", relay.getString("serverId"));
        if (!relay.optString("grant").isEmpty()) url.setQueryParameter("grant", relay.getString("grant"));
        JSONObject hello = new JSONObject().put("t", "hello").put("v", 1).put("batch", false)
            .put("nonce", encode(crypto.nonce)).put("clientPubJwk", new JSONObject()
                .put("kty", "EC").put("crv", "P-256").put("x", encode(crypto.x)).put("y", encode(crypto.y)));
        socket = client.newWebSocket(new Request.Builder().url(url.build()).build(), new WebSocketListener() {
            @Override public void onOpen(WebSocket ws, Response response) {
                if (closed.get()) { ws.cancel(); return; }
                ws.send(hello.toString());
            }
            @Override public void onMessage(WebSocket ws, String text) {
                if (closed.get()) return;
                try {
                    if (text.length() > 4096) throw new IllegalArgumentException("Invalid handshake");
                    JSONObject ready = new JSONObject(text);
                    if (!"ready".equals(ready.optString("t")) || ready.optInt("v") != 1 || ready.optBoolean("batch")) {
                        throw new IllegalArgumentException("Invalid handshake");
                    }
                    if (established) return;
                    established = true;
                    JSONObject head = new JSONObject().put("method", "GET").put("path", PATH).put("query", "").put("headers", headers);
                    send(ws, 1, 1, head.toString().getBytes(StandardCharsets.UTF_8));
                    send(ws, 4, 1, new byte[0]);
                } catch (Exception error) { fail(false); }
            }
            @Override public void onMessage(WebSocket ws, ByteString bytes) {
                if (closed.get()) return;
                try {
                    if (!established || bytes.size() > 65565) throw new IllegalArgumentException("Invalid frame");
                    byte[] frame = crypto.decrypt(bytes.toByteArray());
                    if (frame.length < 5) throw new IllegalArgumentException("Invalid frame");
                    lastReceived = android.os.SystemClock.elapsedRealtime();
                    int type = frame[0] & 0x7f;
                    int streamId = ByteBuffer.wrap(frame, 1, 4).getInt();
                    byte[] payload = Arrays.copyOfRange(frame, 5, frame.length);
                    if (type == 11 && streamId == 0) { send(ws, 12, 0, payload); return; }
                    if (type == 12 && streamId == 0) return;
                    if (streamId != 1) throw new IllegalArgumentException("Unexpected stream");
                    if (type == 3 && (frame[0] & 0x80) == 0 && !accepted) {
                        JSONObject head = new JSONObject(new String(payload, StandardCharsets.UTF_8));
                        JSONObject fields = head.optJSONObject("headers");
                        accepted = validResponse(head.optInt("status"), fields == null ? "" : fields.optString("content-type"));
                    } else if (type == 2 && accepted) {
                        // HTTP body fragments are one byte stream, not JSON messages.
                        parser.accept(payload);
                    } else if (type == 4 || type == 5) {
                        fail(false);
                    } else throw new IllegalArgumentException("Unexpected frame");
                } catch (Exception error) { fail(false); }
            }
            @Override public void onClosed(WebSocket ws, int code, String reason) { fail(code == 4010 || code == 4029); }
            @Override public void onClosing(WebSocket ws, int code, String reason) { ws.close(code, null); fail(code == 4010 || code == 4029); }
            @Override public void onFailure(WebSocket ws, Throwable error, Response response) {
                fail(response != null && permanentStatus(response.code()));
            }
        });
        if (closed.get()) socket.cancel();
    }

    private void send(WebSocket ws, int type, int streamId, byte[] payload) throws Exception {
        byte[] frame = ByteBuffer.allocate(5 + payload.length).put((byte) type).putInt(streamId).put(payload).array();
        if (!ws.send(ByteString.of(crypto.encrypt(frame)))) throw new IllegalStateException("Closed stream");
    }

    private static boolean permanentStatus(int status) { return status >= 400 && status < 500 && status != 408 && status != 429; }
    private boolean validResponse(int status, String contentType) {
        if (status != 200 || !contentType.toLowerCase(java.util.Locale.ROOT).startsWith("text/event-stream")) {
            fail(permanentStatus(status) || status == 200);
            return false;
        }
        return true;
    }
    private void fail(boolean permanent) {
        if (!closed.compareAndSet(false, true)) return;
        cancel();
        listener.failed(permanent);
    }
    private void cancel() {
        if (call != null) call.cancel();
        if (socket != null) socket.cancel();
    }
    @Override public void close() { closed.set(true); cancel(); }
}
