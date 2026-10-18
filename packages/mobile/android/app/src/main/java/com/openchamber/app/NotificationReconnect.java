package com.openchamber.app;

/** Backoff resets only after a healthy stream, never merely after a socket opens. */
final class NotificationReconnect {
    private int failures;
    long failed(boolean permanent, long healthyMillis) {
        if (healthyMillis >= 30_000) failures = 0;
        long delay = Math.min(300_000L, 2_000L << Math.min(failures++, 8));
        return permanent ? 300_000L : delay;
    }
}
