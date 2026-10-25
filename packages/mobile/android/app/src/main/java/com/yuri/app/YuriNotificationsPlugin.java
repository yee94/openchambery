package com.yuri.app;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.net.URI;
import org.json.JSONObject;

@CapacitorPlugin(name = "YuriNotifications", permissions = {
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public class YuriNotificationsPlugin extends Plugin {
    private boolean permissionRequested;
    private boolean permissionPending;

    @PluginMethod public void configure(PluginCall call) {
        JSObject input = call.getObject("config");
        // Never retain credentials in a bridge call saved across the permission dialog.
        call.getData().remove("config");
        try {
            if (input == null || input.toString().length() > 16_384) throw new IllegalArgumentException();
            JSONObject config = new JSONObject(input.toString());
            config.getJSONObject("headers");
            if (config.optJSONObject("labels") == null) throw new IllegalArgumentException();
            if (!config.optString("baseUrl").isEmpty()) validateUrl(config.getString("baseUrl"), false);
            JSONObject relay = config.optJSONObject("relay");
            if (relay != null) validateUrl(relay.getString("relayUrl"), true);
            if (config.optString("baseUrl").isEmpty() && relay == null) throw new IllegalArgumentException();
            getActivity().runOnUiThread(() -> {
                YuriNotificationService.requested = config;
                if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED && !permissionRequested) {
                    permissionRequested = true;
                    permissionPending = true;
                    requestPermissionForAlias("notifications", call, "notificationPermission");
                } else {
                    call.resolve(new JSObject().put("state", apply()));
                }
            });
        } catch (Exception ignored) { call.reject("Invalid notification connection"); }
    }
    private static void validateUrl(String value, boolean relay) throws Exception {
        URI uri = new URI(value);
        String scheme = uri.getScheme();
        if (uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
            || !(relay ? "ws".equals(scheme) || "wss".equals(scheme) : "http".equals(scheme) || "https".equals(scheme))) {
            throw new IllegalArgumentException();
        }
    }
    @PermissionCallback private void notificationPermission(PluginCall call) {
        permissionPending = false;
        call.resolve(new JSObject().put("state", apply()));
    }
    private String apply() {
        if (YuriNotificationService.requested == null) return "stopped";
        if (!NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) {
            getContext().stopService(new Intent(getContext(), YuriNotificationService.class));
            return "denied";
        }
        if (permissionPending || !YuriNotificationService.appVisible) return "pending";
        try {
            ContextCompat.startForegroundService(getContext(), new Intent(getContext(), YuriNotificationService.class));
            return "started";
        } catch (RuntimeException ignored) { return "unavailable"; }
    }
    @PluginMethod public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            YuriNotificationService.requested = null;
            getContext().stopService(new Intent(getContext(), YuriNotificationService.class));
            call.resolve();
        });
    }
    @Override protected void handleOnResume() {
        YuriNotificationService.appVisible = true;
        apply();
    }
    @Override protected void handleOnPause() { YuriNotificationService.appVisible = false; }
}
