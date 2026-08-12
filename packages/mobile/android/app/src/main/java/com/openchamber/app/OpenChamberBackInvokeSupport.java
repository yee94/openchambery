package com.openchamber.app;

import android.app.Activity;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

/**
 * API 33+ predictive-back invoke registration.
 *
 * Kept out of {@link OpenChamberNavigationPlugin}'s constant pool so Android 12
 * and older never attempt to resolve {@link OnBackInvokedCallback} at plugin
 * class-load time (which is what made the app crash on launch).
 */
final class OpenChamberBackInvokeSupport {
    private OpenChamberBackInvokeSupport() {}

    static Object create(OpenChamberBackNavListener listener) {
        return (OnBackInvokedCallback) listener::onBackInvoked;
    }

    static void register(Activity activity, Object callback) {
        activity
            .getOnBackInvokedDispatcher()
            .registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                (OnBackInvokedCallback) callback
            );
    }

    static void unregister(Activity activity, Object callback) {
        if (callback == null) return;
        activity
            .getOnBackInvokedDispatcher()
            .unregisterOnBackInvokedCallback((OnBackInvokedCallback) callback);
    }
}
