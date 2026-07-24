package com.openchamber.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    static final String ACTION_SHARE_READY = "com.openchamber.app.SHARE_READY";
    static final String ACTION_SHARE_DRAFT_READY = "com.openchamber.app.SHARE_DRAFT_READY";
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(OpenChamberHapticsPlugin.class);
        registerPlugin(OpenChamberNavigationPlugin.class);
        registerPlugin(OpenChamberSharePlugin.class);
        super.onCreate(savedInstanceState);
        dispatchShare(getIntent());
    }

    @Override protected void onNewIntent(android.content.Intent intent) { super.onNewIntent(intent); setIntent(intent); dispatchShare(intent); }
    private void dispatchShare(android.content.Intent intent) { if (ACTION_SHARE_READY.equals(intent.getAction())) { String id = intent.getStringExtra("operationID"); if (id != null && getBridge() != null) ((OpenChamberSharePlugin) getBridge().getPlugin("OpenChamberShare").getInstance()).emitReceived(id); intent.setAction(null); intent.removeExtra("operationID"); } else if (ACTION_SHARE_DRAFT_READY.equals(intent.getAction())) { String id = intent.getStringExtra("draftID"); if (id != null && getBridge() != null) ((OpenChamberSharePlugin) getBridge().getPlugin("OpenChamberShare").getInstance()).emitDraftReceived(id); intent.setAction(null); intent.removeExtra("draftID"); } }
}
