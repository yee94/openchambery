package com.openchamber.app;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "OpenChamberVirtualAsset")
public class OpenChamberVirtualAssetPlugin extends Plugin {
    private final ExecutorService executor = Executors.newCachedThreadPool(runnable -> {
        Thread thread = new Thread(runnable, "openchamber-virtual-asset");
        thread.setDaemon(true);
        return thread;
    });
    private boolean clientInstalled;

    @Override
    public void load() {
        installClientIfNeeded();
    }

    private void installClientIfNeeded() {
        if (clientInstalled) return;
        Bridge bridge = getBridge();
        if (bridge == null) return;
        WebView webView = bridge.getWebView();
        if (webView == null) return;
        webView.post(() -> {
            if (clientInstalled) return;
            Bridge current = getBridge();
            if (current == null || current.getWebView() == null) return;
            current.setWebViewClient(new VirtualAssetWebViewClient(current));
            clientInstalled = true;
        });
    }

    @PluginMethod
    public void create(PluginCall call) {
        installClientIfNeeded();
        String assetId = call.getString("assetId");
        String mime = call.getString("mime");
        if (assetId == null || assetId.isEmpty()) {
            call.reject("assetId is required");
            return;
        }
        if (mime == null || mime.isEmpty()) {
            call.reject("mime is required");
            return;
        }
        executor.execute(() -> {
            try {
                String url = OpenChamberVirtualAssetStore.create(assetId, mime);
                JSObject result = new JSObject();
                result.put("assetId", assetId);
                result.put("url", url);
                call.resolve(result);
            } catch (Exception error) {
                call.reject(error.getMessage(), error);
            }
        });
    }

    @PluginMethod
    public void append(PluginCall call) {
        String assetId = call.getString("assetId");
        String chunk = call.getString("chunk");
        if (assetId == null || assetId.isEmpty()) {
            call.reject("assetId is required");
            return;
        }
        if (chunk == null) {
            call.reject("chunk is required");
            return;
        }
        // Append may block for backpressure; keep off the Capacitor bridge thread.
        executor.execute(() -> {
            try {
                OpenChamberVirtualAssetStore.append(assetId, chunk);
                call.resolve();
            } catch (Exception error) {
                call.reject(error.getMessage(), error);
            }
        });
    }

    @PluginMethod
    public void finish(PluginCall call) {
        String assetId = call.getString("assetId");
        if (assetId == null || assetId.isEmpty()) {
            call.reject("assetId is required");
            return;
        }
        executor.execute(() -> {
            try {
                OpenChamberVirtualAssetStore.finish(assetId);
                call.resolve();
            } catch (Exception error) {
                call.reject(error.getMessage(), error);
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String assetId = call.getString("assetId");
        if (assetId == null || assetId.isEmpty()) {
            call.reject("assetId is required");
            return;
        }
        executor.execute(() -> {
            try {
                OpenChamberVirtualAssetStore.cancel(assetId);
                call.resolve();
            } catch (Exception error) {
                call.reject(error.getMessage(), error);
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
        super.handleOnDestroy();
    }

    /**
     * Intercepts {@code openchamber-asset://v/{assetId}} and returns a streaming
     * {@link WebResourceResponse} backed by a blocking progressive InputStream.
     */
    static final class VirtualAssetWebViewClient extends BridgeWebViewClient {
        VirtualAssetWebViewClient(Bridge bridge) {
            super(bridge);
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            if (request != null && request.getUrl() != null) {
                String assetId = OpenChamberVirtualAssetStore.extractAssetId(request.getUrl());
                if (assetId != null) {
                    return virtualAssetResponse(assetId);
                }
            }
            return super.shouldInterceptRequest(view, request);
        }

        private static WebResourceResponse virtualAssetResponse(String assetId) {
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            headers.put("Accept-Ranges", "none");
            headers.put("X-Content-Type-Options", "nosniff");
            try {
                String mime = OpenChamberVirtualAssetStore.mimeOf(assetId);
                if (mime == null) {
                    headers.put("Content-Type", "text/plain; charset=utf-8");
                    return new WebResourceResponse(
                        "text/plain",
                        "utf-8",
                        404,
                        "Not Found",
                        headers,
                        new ByteArrayInputStream(new byte[0])
                    );
                }
                InputStream stream = OpenChamberVirtualAssetStore.openStream(assetId);
                headers.put("Content-Type", mime);
                return new WebResourceResponse(mime, null, 200, "OK", headers, stream);
            } catch (Exception error) {
                headers.put("Content-Type", "text/plain; charset=utf-8");
                return new WebResourceResponse(
                    "text/plain",
                    "utf-8",
                    404,
                    "Not Found",
                    headers,
                    new ByteArrayInputStream(new byte[0])
                );
            }
        }
    }
}
