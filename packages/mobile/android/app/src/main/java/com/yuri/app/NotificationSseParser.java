package com.yuri.app;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

/** Incremental UTF-8 SSE parser shared by direct HTTP and relay body frames. */
final class NotificationSseParser {
    interface Listener { void event(String id, String data) throws Exception; }
    private static final int LIMIT = 32 * 1024;
    private final ByteArrayOutputStream line = new ByteArrayOutputStream();
    private final StringBuilder data = new StringBuilder();
    private final Listener listener;
    private String id = "";
    private int eventBytes;
    private boolean previousCR;

    NotificationSseParser(Listener listener) { this.listener = listener; }

    void accept(byte[] bytes) throws Exception {
        for (byte value : bytes) {
            if (value == '\n' && previousCR) { previousCR = false; continue; }
            previousCR = value == '\r';
            if (value == '\n' || value == '\r') {
                consumeLine();
            } else {
                if (++eventBytes > LIMIT) throw new IllegalArgumentException("Notification too large");
                line.write(value);
            }
        }
    }

    private void consumeLine() throws Exception {
        String text = new String(line.toByteArray(), StandardCharsets.UTF_8);
        line.reset();
        if (text.isEmpty()) {
            if (data.length() > 0) listener.event(id, data.substring(0, data.length() - 1));
            data.setLength(0);
            id = "";
            eventBytes = 0;
        } else if (text.startsWith(":")) {
            // Heartbeats are not events and must not accumulate against the event budget.
            eventBytes = Math.max(0, eventBytes - text.getBytes(StandardCharsets.UTF_8).length);
        } else {
            int colon = text.indexOf(':');
            String key = colon < 0 ? text : text.substring(0, colon);
            String value = colon < 0 ? "" : text.substring(colon + 1);
            if (value.startsWith(" ")) value = value.substring(1);
            if (key.equals("data")) data.append(value).append('\n');
            if (key.equals("id") && value.indexOf('\0') < 0 && value.length() <= 128) id = value;
        }
    }
}
