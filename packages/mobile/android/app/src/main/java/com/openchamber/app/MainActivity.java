package com.openchamber.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    static final String ACTION_SHARE_READY = "com.openchamber.app.SHARE_READY";
    static final String ACTION_SHARE_DRAFT_READY = "com.openchamber.app.SHARE_DRAFT_READY";
    static final String ACTION_ASSISTANT_OPEN_READY = "com.openchamber.app.ASSISTANT_OPEN_READY";

    private ImeSyncBridge imeSyncBridge;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(OpenChamberHapticsPlugin.class);
        registerPlugin(OpenChamberNavigationPlugin.class);
        registerPlugin(OpenChamberSharePlugin.class);
        registerPlugin(OpenChamberExternalBrowserPlugin.class);
        super.onCreate(savedInstanceState);
        dispatchShare(getIntent());
        // After the Keyboard plugin installs its root animation callback, remove
        // that callback so IME animation stays off the app's main-thread callback
        // path. Also owns WebView-parent padding/backdrop and emits state-only
        // IME bookends for cached-height CSS composer choreography.
        // Double-post = after load.
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().post(() ->
                getBridge().getWebView().post(() -> {
                    imeSyncBridge = new ImeSyncBridge(this);
                    imeSyncBridge.attach();
                })
            );
        }
    }

    @Override
    protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        dispatchShare(intent);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && imeSyncBridge != null) {
            imeSyncBridge.hideNavigationBar();
        }
    }

    private void dispatchShare(android.content.Intent intent) {
        if (ACTION_SHARE_READY.equals(intent.getAction())) {
            String id = intent.getStringExtra("operationID");
            if (id != null && getBridge() != null) {
                ((OpenChamberSharePlugin) getBridge().getPlugin("OpenChamberShare").getInstance()).emitReceived(id);
            }
            intent.setAction(null);
            intent.removeExtra("operationID");
        } else if (ACTION_SHARE_DRAFT_READY.equals(intent.getAction())) {
            String id = intent.getStringExtra("draftID");
            if (id != null && getBridge() != null) {
                ((OpenChamberSharePlugin) getBridge().getPlugin("OpenChamberShare").getInstance()).emitDraftReceived(id);
            }
            intent.setAction(null);
            intent.removeExtra("draftID");
        } else if (ACTION_ASSISTANT_OPEN_READY.equals(intent.getAction())) {
            String id = intent.getStringExtra("requestID");
            if (id != null && getBridge() != null) {
                ((OpenChamberSharePlugin) getBridge().getPlugin("OpenChamberShare").getInstance()).emitAssistantOpenRequested(id);
            }
            intent.setAction(null);
            intent.removeExtra("requestID");
        }
    }
}
