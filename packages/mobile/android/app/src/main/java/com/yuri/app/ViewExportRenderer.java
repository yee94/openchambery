package com.yuri.app;

import android.app.Activity;
import android.graphics.Canvas;
import android.graphics.Color;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import java.io.ByteArrayInputStream;

/** A separate, attached, noninteractive WebView with no Capacitor bridge. Main-thread only. */
final class ViewExportRenderer {
    interface Callback {
        void ready();
        void failed();
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable timeout;
    private WebView view;
    private FrameLayout host;
    private boolean completed;

    ViewExportRenderer(Activity activity, ViewExportRequest request, Callback callback) {
        timeout = () -> fail(callback);
        try {
            view = new WebView(activity);
            WebSettings settings = view.getSettings();
            settings.setJavaScriptEnabled(false);
            settings.setJavaScriptCanOpenWindowsAutomatically(false);
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(false);
            settings.setAllowFileAccessFromFileURLs(false);
            settings.setAllowUniversalAccessFromFileURLs(false);
            settings.setBlockNetworkLoads(true);
            settings.setBlockNetworkImage(true);
            settings.setDomStorageEnabled(false);
            settings.setDatabaseEnabled(false);
            settings.setGeolocationEnabled(false);
            settings.setSaveFormData(false);
            settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) settings.setSafeBrowsingEnabled(false);
            settings.setSupportMultipleWindows(false);
            settings.setSupportZoom(false);
            settings.setTextZoom(100);
            settings.setUseWideViewPort(true);
            settings.setLoadWithOverviewMode(false);
            settings.setOffscreenPreRaster(true);
            view.setInitialScale(100);
            view.setBackgroundColor(Color.WHITE);
            view.setHorizontalScrollBarEnabled(false);
            view.setVerticalScrollBarEnabled(false);
            view.setFocusable(false);
            view.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            view.setOnTouchListener((v, event) -> true);
            view.setWebViewClient(new WebViewClient() {
                @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest resource) { return true; }
                @Override public boolean shouldOverrideUrlLoading(WebView v, String url) { return true; }
                @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest resource) {
                    // Android also dispatches data: requests here. Inline images/fonts
                    // must reach Chromium's decoder; all external schemes are denied.
                    if ("data".equalsIgnoreCase(resource.getUrl().getScheme())) return null;
                    return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                }
                @Override public void onPageFinished(WebView v, String url) {
                    if (completed || view == null) return;
                    v.postVisualStateCallback(1, new WebView.VisualStateCallback() {
                        @Override public void onComplete(long id) {
                            if (completed || view == null) return;
                            completed = true;
                            main.removeCallbacks(timeout);
                            // The full document is this view's viewport, rather than drawing
                            // outside a screen-sized viewport. No global slow-draw mode.
                            callback.ready();
                        }
                    });
                }
                @Override public void onReceivedError(WebView v, WebResourceRequest resource, WebResourceError error) {
                    if (resource.isForMainFrame()) fail(callback);
                }
                @Override public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) {
                    completed = false;
                    fail(callback);
                    return true;
                }
            });
            host = new FrameLayout(activity);
            host.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            host.setTranslationX(-request.width - 1f);
            host.addView(view, new FrameLayout.LayoutParams(request.width, request.height));
            ((ViewGroup) activity.getWindow().getDecorView()).addView(host,
                new ViewGroup.LayoutParams(request.width, request.height));
            host.measure(View.MeasureSpec.makeMeasureSpec(request.width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(request.height, View.MeasureSpec.EXACTLY));
            host.layout(0, 0, request.width, request.height);
            main.postDelayed(timeout, 30_000);
            view.loadDataWithBaseURL(null, request.document(), "text/html", "UTF-8", null);
        } catch (RuntimeException | OutOfMemoryError error) {
            // Post so the owner has installed this renderer before cleanup runs.
            main.post(() -> fail(callback));
        } finally {
            request.html = null;
        }
    }

    void draw(Canvas canvas) {
        if (view == null || !completed) throw new IllegalStateException("Renderer is not ready");
        view.draw(canvas);
    }

    private void fail(Callback callback) {
        if (completed) return;
        completed = true;
        main.removeCallbacks(timeout);
        callback.failed();
    }

    void close() {
        completed = true;
        main.removeCallbacks(timeout);
        if (view != null) {
            view.stopLoading();
            hostRemoveView();
            view.destroy();
            view = null;
        }
        if (host != null && host.getParent() instanceof ViewGroup) ((ViewGroup) host.getParent()).removeView(host);
        host = null;
    }

    private void hostRemoveView() {
        if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
    }
}
