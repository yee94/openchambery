package com.openchamber.app;

import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.view.View;
import android.view.Window;
import android.webkit.WebView;
import androidx.annotation.NonNull;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsAnimationCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import java.util.List;
import java.util.Locale;

/**
 * Minimal Android IME lift for Capacitor WebView.
 *
 * Geometry:
 *   1. WebView parent padding stays 0 (no SystemBars IME pad + translation double-count).
 *   2. Each IME frame: {@code translationY = -imeBottom} (compositor).
 *
 * Backdrop (the "shadow" / gray strip above the keyboard):
 *   Not a VIVO-specific protocol and not in the DOM. On edge-to-edge Android,
 *   lifting the WebView reveals the Activity window / navigation-bar surface
 *   between the page and the IME. Capacitor / Ionic threads call this a gray
 *   strip "not visible in chrome://inspect". Fix: paint window, decor, WebView
 *   parent, and navigation bar the same color as the web page background.
 *
 * @see https://developer.android.com/develop/ui/views/layout/sw-keyboard
 * @see https://forum.ionicframework.com/t/android-keyboard-edge-to-edge-issue-gray-area-after-keyboard-hide-and-inconsistent-resize-capacitor-8/251049
 */
final class ImeSyncBridge {
    private final BridgeActivity activity;
    private Bridge bridge;
    private View webParent;
    /** Last painted backdrop (ARGB). Avoid redundant window writes. */
    private int lastBackdropArgb = Color.TRANSPARENT;

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

        // Initial backdrop from theme defaults; refined once CSS --background is readable.
        paintBackdrop(resolveThemeBackdrop());
        webView.post(this::syncBackdropFromWeb);

        if (webParent != null) {
            ViewCompat.setOnApplyWindowInsetsListener(webParent, (v, insets) -> {
                v.setPadding(0, 0, 0, 0);
                Insets systemBars = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
                );
                boolean imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime());
                int imePx = Math.max(0, insets.getInsets(WindowInsetsCompat.Type.ime()).bottom);
                if (webParent.getTranslationY() != -imePx) {
                    applyTranslation(imeVisible ? -imePx : 0);
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

        ViewCompat.setWindowInsetsAnimationCallback(
            rootView,
            new WindowInsetsAnimationCompat.Callback(WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_STOP) {
                @NonNull
                @Override
                public WindowInsetsAnimationCompat.BoundsCompat onStart(
                    @NonNull WindowInsetsAnimationCompat animation,
                    @NonNull WindowInsetsAnimationCompat.BoundsCompat bounds
                ) {
                    if (!isIme(animation)) return super.onStart(animation, bounds);
                    // Re-sync backdrop when the IME opens so theme/light-dark matches the page.
                    syncBackdropFromWeb();
                    WindowInsetsCompat rootInsets = ViewCompat.getRootWindowInsets(rootView);
                    boolean showing = rootInsets != null && rootInsets.isVisible(WindowInsetsCompat.Type.ime());
                    int imePx = imeBottomPx(rootInsets);
                    applyTranslation(-imePx);
                    notifyJs("oc:ime-start", showing, pxToCss(imePx));
                    return super.onStart(animation, bounds);
                }

                @NonNull
                @Override
                public WindowInsetsCompat onProgress(
                    @NonNull WindowInsetsCompat insets,
                    @NonNull List<WindowInsetsAnimationCompat> runningAnimations
                ) {
                    if (!imeRunning(runningAnimations)) return insets;
                    applyTranslation(-imeBottomPx(insets));
                    return insets;
                }

                @Override
                public void onEnd(@NonNull WindowInsetsAnimationCompat animation) {
                    super.onEnd(animation);
                    if (!isIme(animation)) return;
                    WindowInsetsCompat rootInsets = ViewCompat.getRootWindowInsets(rootView);
                    boolean showing = rootInsets != null && rootInsets.isVisible(WindowInsetsCompat.Type.ime());
                    int imePx = showing ? imeBottomPx(rootInsets) : 0;
                    applyTranslation(showing ? -imePx : 0);
                    notifyJs("oc:ime-end", showing, pxToCss(imePx));
                }
            }
        );
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
            // Navigation bar sits under/near the IME on many OEMs; match it so no
            // second band appears. Contrast enforcement can force a translucent scrub.
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
                // Light/dark nav icons from luminance of the fill.
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
        // Read computed --background (or body) as rgb() and paint native surfaces.
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

    /** Splash / theme defaults used before the web page paints. */
    private int resolveThemeBackdrop() {
        // Prefer the same splash tokens MobileApp writes for StatusBar.
        try {
            WebView webView = bridge != null ? bridge.getWebView() : null;
            if (webView != null) {
                // Synchronous fallback colors; refined async via syncBackdropFromWeb.
            }
        } catch (Exception ignored) {
            // fall through
        }
        boolean night =
            (activity.getResources().getConfiguration().uiMode
                & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
                == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        // Match packages/ui MobileApp StatusBar defaults.
        return night ? Color.parseColor("#171515") : Color.parseColor("#fffdf4");
    }

    /**
     * Parse evaluateJavascript string results: "\"rgb(23, 21, 21)\"" / "\"#171515\"".
     * Returns 0 if unparseable.
     */
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
            // rgb(r, g, b) or rgba(r, g, b, a)
            if (s.startsWith("rgb")) {
                int open = s.indexOf('(');
                int close = s.indexOf(')');
                if (open < 0 || close <= open) return 0;
                String[] parts = s.substring(open + 1, close).split(",");
                if (parts.length < 3) return 0;
                int r = clamp255(parseCssChannel(parts[0]));
                int g = clamp255(parseCssChannel(parts[1]));
                int b = clamp255(parseCssChannel(parts[2]));
                int a = parts.length >= 4 ? clamp255(Math.round(parseCssChannel(parts[3]) * 255f)) : 255;
                if (parts[3].trim().contains("%") || parseCssChannel(parts[3]) > 1f) {
                    a = clamp255(Math.round(parseCssChannel(parts[3])));
                } else if (parts.length >= 4) {
                    float af = parseCssChannel(parts[3]);
                    a = af <= 1f ? clamp255(Math.round(af * 255f)) : clamp255(Math.round(af));
                }
                return Color.argb(a, r, g, b);
            }
            // oklch(...) — approximate via leaving to theme fallback
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
        // Relative luminance (sRGB).
        double lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        return lum > 0.5;
    }

    private static boolean isIme(@NonNull WindowInsetsAnimationCompat animation) {
        return (animation.getTypeMask() & WindowInsetsCompat.Type.ime()) != 0;
    }

    private static boolean imeRunning(@NonNull List<WindowInsetsAnimationCompat> running) {
        for (WindowInsetsAnimationCompat anim : running) {
            if (isIme(anim)) return true;
        }
        return false;
    }

    private static int imeBottomPx(WindowInsetsCompat insets) {
        if (insets == null) return 0;
        return Math.max(0, insets.getInsets(WindowInsetsCompat.Type.ime()).bottom);
    }

    private void applyTranslation(float ty) {
        if (webParent == null) return;
        if (webParent.getTranslationY() == ty) return;
        webParent.setTranslationY(ty);
    }

    private int pxToCss(int px) {
        float density = activity.getResources().getDisplayMetrics().density;
        if (density <= 0f) density = 1f;
        return Math.max(0, Math.round(px / density));
    }

    private void notifyJs(String name, boolean open, int heightCss) {
        if (bridge == null || bridge.getWebView() == null) return;
        String script = String.format(
            Locale.US,
            "try{window.dispatchEvent(new CustomEvent('%s',{detail:{\"open\":%s,\"height\":%d}}));}catch(e){}",
            name,
            open,
            heightCss
        );
        bridge.getWebView().evaluateJavascript(script, null);
    }
}
