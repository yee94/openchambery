package com.openchamber.app;

import android.app.Activity;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Progress-only native back input for the shared UI navigation coordinator.
 *
 * Android 14+ Predictive Back types ({@code OnBackAnimationCallback}) and
 * Android 13 invoke types live in companion support classes so this plugin can
 * be registered on Android 12 without resolving those framework classes.
 */
@CapacitorPlugin(name = "OpenChamberNavigation")
public class OpenChamberNavigationPlugin extends Plugin {
    private Object callback;
    private boolean registered;

    private final OpenChamberBackNavListener listener = new OpenChamberBackNavListener() {
        @Override
        public void onBackStarted(float progress) {
            notifyProgress("backStarted", progress);
        }

        @Override
        public void onBackProgressed(float progress) {
            notifyProgress("backProgressed", progress);
        }

        @Override
        public void onBackCancelled() {
            notifyListeners("backCancelled", new JSObject());
        }

        @Override
        public void onBackInvoked() {
            notifyListeners("backInvoked", new JSObject());
        }
    };

    @PluginMethod
    public void setEnabled(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(() -> {
            setRegistered(activity, enabled);
            call.resolve();
        });
    }

    private void setRegistered(Activity activity, boolean enabled) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || enabled == registered) return;
        if (enabled) {
            // Touch API 33/34 support classes only after the SDK gate. Loading those
            // classes on Android 12 resolves missing android.window.* types and crashes.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                callback = OpenChamberBackAnimationSupport.create(listener);
            } else {
                callback = OpenChamberBackInvokeSupport.create(listener);
            }
            OpenChamberBackInvokeSupport.register(activity, callback);
            registered = true;
            return;
        }
        OpenChamberBackInvokeSupport.unregister(activity, callback);
        callback = null;
        registered = false;
    }

    private void notifyProgress(String eventName, float progress) {
        JSObject event = new JSObject();
        event.put("progress", Math.max(0f, Math.min(1f, progress)));
        notifyListeners(eventName, event);
    }

    @Override
    protected void handleOnDestroy() {
        Activity activity = getActivity();
        if (activity != null) setRegistered(activity, false);
        super.handleOnDestroy();
    }
}
