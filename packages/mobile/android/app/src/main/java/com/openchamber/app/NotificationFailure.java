package com.openchamber.app;

/** Safe diagnostic categories: never expose exception messages, URLs or credentials. */
enum NotificationFailure {
    NETWORK("reconnecting", false),
    AUTH("auth", true),
    ENDPOINT("endpoint", true),
    RESPONSE("response", true),
    SERVER("server", false),
    RELAY("relay", false),
    RELAY_LIMIT("relay", true),
    IDENTITY("identity", true),
    INITIALIZATION("unavailable", true);

    final String label;
    final boolean permanent;

    NotificationFailure(String label, boolean permanent) {
        this.label = label;
        this.permanent = permanent;
    }

    static NotificationFailure http(int status, boolean notificationEndpoint) {
        if (status == 401 || status == 403) return AUTH;
        if (notificationEndpoint && (status == 404 || status == 405 || status == 501)) return ENDPOINT;
        if (status == 408) return NETWORK;
        if (status == 429 || status >= 500) return SERVER;
        return RESPONSE;
    }

    static NotificationFailure relayClose(int code) {
        if (code == 4010) return AUTH;
        if (code == 4029) return RELAY_LIMIT;
        return RELAY;
    }
}
