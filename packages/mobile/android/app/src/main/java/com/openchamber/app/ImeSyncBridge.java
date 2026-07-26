package com.openchamber.app;

import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.view.View;
import android.view.Window;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import java.util.Locale;

/**
 * Android IME companion for Capacitor WebView — no whole-page lift.
 *
 * Geometry:
 *   WebView parent padding stays 0 so SystemBars does not pad for IME
 *   (that would layout-shrink the page under the keyboard). The page keeps
 *   full height; JS lifts only the composer (transform FLIP) so the header
 *   stays pinned to the top.
 *
 * Composer timing:
 *   JS starts a short composer-only CSS transform from keyboard intent/focus,
 *   using the previous measured IME height. This bridge emits only visibility
 *   state + settled height from the inset listener so JS can calibrate/cache
 *   the next open. There is no progress bridge or per-frame JS geometry.
 *
 * Backdrop (gray strip above the keyboard on edge-to-edge):
 *   Paint window / decor / WebView parent / nav bar to match page --background.
 *
 * @see https://developer.android.com/develop/ui/views/layout/sw-keyboard
 */
final class ImeSyncBridge {
    private final BridgeActivity activity;
    private Bridge bridge;
    private View webParent;
    /** Last painted backdrop (ARGB). Avoid redundant window writes. */
    private int lastBackdropArgb = Color.TRANSPARENT;
    private boolean lastImeVisible = false;

    ImeSyncBridge(BridgeActivity activity) {
        this.activity = activity;
    }

    void attach() {
        bridge = activity.getBridge();
        if (bridge == null) return;
        WebView webView = bridge.getWebView();
        if (webView == null) return;
        View content = activity.getWindow().getDecorView().findViewById(android.R.id.content);
        if (content == null) return;
        webParent = (View) webView.getParent();
        View rootView = content.getRootView();

        paintBackdrop(resolveThemeBackdrop());
        webView.post(this::syncBackdropFromWeb);

        if (webParent != null) {
            // Own this view's padding so SystemBars cannot IME-pad the WebView.
            // Do not translationY the WebView — that would drag the header off-screen.
            ViewCompat.setOnApplyWindowInsetsListener(webParent, (v, insets) -> {
                v.setPadding(0, 0, 0, 0);
                Insets systemBars = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
                );
                boolean imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime());
                if (imeVisible != lastImeVisible) {
                    if (imeVisible) syncBackdropFromWeb();
                    lastImeVisible = imeVisible;
                    notifyImeState(
                        imeVisible,
                        imeVisible ? insets.getInsets(WindowInsetsCompat.Type.ime()).bottom : 0
                    );
                }
                return new WindowInsetsCompat.Builder(insets)
                    .setInsets(
                        WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout(),
                        Insets.of(
                            systemBars.left,
                            systemBars.top,
                            systemBars.right,
                            imeVisible ? 0 : systemBars.bottom
                        )
                    )
                    .build();
            });
            webParent.setPadding(0, 0, 0, 0);
            webParent.requestApplyInsets();
        }

        // Capacitor Keyboard installs an empty root animation callback. Remove it
        // so the IME animation can stay off the app's main-thread callback path.
        ViewCompat.setWindowInsetsAnimationCallback(rootView, null);
    }

    /**
     * Paint every native surface that can show between the WebView and the IME.
     * Color must match the web {@code --background} or the strip remains visible.
     */
    private void paintBackdrop(int argb) {
        if (argb == lastBackdropArgb) return;
        lastBackdropArgb = argb;
        Window window = activity.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(argb));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                window.setNavigationBarContrastEnforced(false);
            }
            window.setNavigationBarColor(argb);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                window.setNavigationBarDividerColor(argb);
            }
            View decor = window.getDecorView();
            if (decor != null) {
                decor.setBackgroundColor(argb);
                boolean lightBg = isLightColor(argb);
                WindowInsetsControllerCompat controller =
                    WindowCompat.getInsetsController(window, decor);
                if (controller != null) {
                    controller.setAppearanceLightNavigationBars(lightBg);
                }
            }
        }
        if (webParent != null) {
            webParent.setBackgroundColor(argb);
        }
        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().setBackgroundColor(argb);
        }
    }

    private void syncBackdropFromWeb() {
        if (bridge == null || bridge.getWebView() == null) return;
        String script =
            "(function(){"
                + "try{"
                + "var s=getComputedStyle(document.documentElement);"
                + "var c=s.getPropertyValue('--background').trim()||s.backgroundColor;"
                + "if(!c||c==='transparent'||c==='rgba(0, 0, 0, 0)'){"
                + "c=getComputedStyle(document.body).backgroundColor;"
                + "}"
                + "return c||'';"
                + "}catch(e){return '';}"
                + "})()";
        bridge.getWebView().evaluateJavascript(script, value -> {
            int parsed = parseCssColor(value);
            if (parsed != 0) {
                activity.runOnUiThread(() -> paintBackdrop(parsed));
            }
        });
    }

    private int resolveThemeBackdrop() {
        boolean night =
            (activity.getResources().getConfiguration().uiMode
                & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
                == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        return night ? Color.parseColor("#171515") : Color.parseColor("#fffdf4");
    }

    private static int parseCssColor(String raw) {
        if (raw == null || raw.length() < 3) return 0;
        String s = raw.trim();
        if (s.length() >= 2 && s.charAt(0) == '"' && s.charAt(s.length() - 1) == '"') {
            s = s.substring(1, s.length() - 1);
        }
        s = s.replace("\\u003c", "<").trim();
        if (s.isEmpty() || "null".equals(s) || "undefined".equals(s)) return 0;
        try {
            if (s.startsWith("#")) {
                return Color.parseColor(s.length() == 4
                    ? ("#" + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2) + s.charAt(3) + s.charAt(3))
                    : s);
            }
            if (s.startsWith("rgb")) {
                int open = s.indexOf('(');
                int close = s.indexOf(')');
                if (open < 0 || close <= open) return 0;
                String[] parts = s.substring(open + 1, close).split(",");
                if (parts.length < 3) return 0;
                int r = clamp255(parseCssChannel(parts[0]));
                int g = clamp255(parseCssChannel(parts[1]));
                int b = clamp255(parseCssChannel(parts[2]));
                int a = 255;
                if (parts.length >= 4) {
                    float af = parseCssChannel(parts[3]);
                    a = af <= 1f ? clamp255(Math.round(af * 255f)) : clamp255(Math.round(af));
                }
                return Color.argb(a, r, g, b);
            }
            return 0;
        } catch (Exception e) {
            return 0;
        }
    }

    private static float parseCssChannel(String part) {
        String t = part.trim();
        if (t.endsWith("%")) {
            return Float.parseFloat(t.substring(0, t.length() - 1)) * 2.55f;
        }
        return Float.parseFloat(t);
    }

    private static int clamp255(float v) {
        return Math.max(0, Math.min(255, Math.round(v)));
    }

    private static boolean isLightColor(int argb) {
        double r = Color.red(argb) / 255.0;
        double g = Color.green(argb) / 255.0;
        double b = Color.blue(argb) / 255.0;
        double lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        return lum > 0.5;
    }

    /** State-only notification for classes / auto-follow freeze; geometry stays native. */
    private void notifyImeState(boolean open, int heightPx) {
        if (bridge == null) return;
        float density = activity.getResources().getDisplayMetrics().density;
        if (density <= 0f) density = 1f;
        int heightCss = Math.max(0, Math.round(heightPx / density));
        String data = String.format(
            Locale.US,
            "{\"open\":%s,\"height\":%d}",
            open,
            heightCss
        );
        bridge.triggerJSEvent("oc:ime-state", "window", data);
    }

}
