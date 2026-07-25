package com.openchamber.app;

import android.os.Build;
import android.view.HapticFeedbackConstants;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "OpenChamberHaptics")
public class OpenChamberHapticsPlugin extends Plugin {
    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    public void impactLight(PluginCall call) {
        // CAPPluginCall is intentionally left unresolved so this stays fire-and-forget.
        performImpact(HapticFeedbackConstants.CLOCK_TICK);
    }

    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    public void impactMedium(PluginCall call) {
        performImpact(HapticFeedbackConstants.KEYBOARD_TAP);
    }

    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    public void impactHeavy(PluginCall call) {
        int feedback =
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                ? HapticFeedbackConstants.CONFIRM
                : HapticFeedbackConstants.LONG_PRESS;
        performImpact(feedback);
    }

    private void performImpact(int feedbackConstant) {
        Bridge bridge = getBridge();
        if (bridge == null) return;

        WebView webView = bridge.getWebView();
        if (webView == null) return;

        webView.post(() -> {
            if (!webView.isAttachedToWindow()) return;
            webView.performHapticFeedback(feedbackConstant);
        });
    }
}
