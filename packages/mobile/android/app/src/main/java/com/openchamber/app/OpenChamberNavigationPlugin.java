package com.openchamber.app;

import android.app.Activity;
import android.os.Build;
import android.window.BackEvent;
import android.window.OnBackAnimationCallback;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "OpenChamberNavigation")
public class OpenChamberNavigationPlugin extends Plugin {
    private OnBackInvokedCallback callback;
    private boolean registered;

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
        OnBackInvokedDispatcher dispatcher = activity.getOnBackInvokedDispatcher();
        if (enabled) {
            callback = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
                ? createAnimationCallback()
                : createInvokeCallback();
            dispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback);
            registered = true;
            return;
        }
        if (callback != null) dispatcher.unregisterOnBackInvokedCallback(callback);
        callback = null;
        registered = false;
    }

    private OnBackInvokedCallback createInvokeCallback() {
        return () -> notifyListeners("backInvoked", new JSObject());
    }

    private OnBackAnimationCallback createAnimationCallback() {
        return new OnBackAnimationCallback() {
            @Override
            public void onBackStarted(BackEvent backEvent) {
                notifyProgress("backStarted", backEvent.getProgress());
            }

            @Override
            public void onBackProgressed(BackEvent backEvent) {
                notifyProgress("backProgressed", backEvent.getProgress());
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
