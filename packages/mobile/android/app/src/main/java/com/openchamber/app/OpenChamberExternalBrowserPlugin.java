package com.openchamber.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "OpenChamberExternalBrowser")
public class OpenChamberExternalBrowserPlugin extends Plugin {
    @PluginMethod
    public void open(PluginCall call) {
        String rawUrl = call.getString("url");
        if (rawUrl == null || rawUrl.trim().isEmpty()) {
            call.reject("An http(s) URL is required.");
            return;
        }

        Uri url = Uri.parse(rawUrl.trim());
        String scheme = url.getScheme();
        if (
            url.getHost() == null ||
            (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme))
        ) {
            call.reject("An http(s) URL is required.");
            return;
        }

        Activity activity = getActivity();
        if (activity == null) {
            call.reject("The browser is unavailable.");
            return;
        }

        activity.runOnUiThread(() -> {
            Intent intent = new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE);
            try {
                activity.startActivity(intent);
                call.resolve();
            } catch (ActivityNotFoundException error) {
                call.reject("The browser is unavailable.", error);
            }
        });
    }
}
