package com.openchamber.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import java.util.ArrayList;

public class ShareReceiverActivity extends Activity {
    static final String SHARE_TARGET_CATEGORY = "com.openchamber.app.SHARE_ASSISTANT";
    static final String ACTION_OPEN_ASSISTANT = "com.openchamber.app.action.OPEN_SHARE_ASSISTANT";
    @Override public void onCreate(Bundle state) { super.onCreate(state); receive(getIntent()); }
    @Override public void onNewIntent(Intent intent) { super.onNewIntent(intent); receive(intent); }
    private void receive(Intent intent) {
        try {
            String action = intent.getAction();
            if (ACTION_OPEN_ASSISTANT.equals(action)) {
                startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP));
                finish();
                return;
            }
            if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) { finish(); return; }
            android.os.PersistableBundle shortcutTarget = shortcutTarget(intent);
            String sourceServerID = intent.getStringExtra("serverInstanceID"), sourceAssistantID = intent.getStringExtra("assistantID");
            String serverID = shortcutTarget != null && shortcutTarget.getString("serverInstanceID") != null ? shortcutTarget.getString("serverInstanceID") : sourceServerID;
            String assistantID = shortcutTarget != null && shortcutTarget.getString("assistantID") != null ? shortcutTarget.getString("assistantID") : sourceAssistantID;
            android.content.ClipData clip = intent.getClipData(); ArrayList<Uri> images = new ArrayList<>();
            if (Intent.ACTION_SEND_MULTIPLE.equals(action)) { ArrayList<Uri> shared = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM); if (shared != null) images.addAll(shared); }
            else { Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM); if (stream != null) images.add(stream); }
            if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) { Uri uri = clip.getItemAt(i).getUri(); if (uri != null && !images.contains(uri)) images.add(uri); }
            String text = intent.getStringExtra(Intent.EXTRA_TEXT); if (text == null && clip != null && clip.getItemCount() > 0) text = String.valueOf(clip.getItemAt(0).coerceToText(this));
            String operationID = OpenChamberShareStore.stage(this, OpenChamberShareStore.defaultTarget(this, serverID, assistantID), text, images);
            Intent main = new Intent(this, MainActivity.class).setAction(MainActivity.ACTION_SHARE_READY).putExtra("operationID", operationID).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP); startActivity(main);
        } catch (Exception error) { android.widget.Toast.makeText(this, error.getMessage(), android.widget.Toast.LENGTH_LONG).show(); }
        finish();
    }
    private android.os.PersistableBundle shortcutTarget(Intent intent) {
        if (android.os.Build.VERSION.SDK_INT < 25) return null;
        String shortcutID = intent.getStringExtra(Intent.EXTRA_SHORTCUT_ID);
        if (shortcutID == null) return null;
        android.content.pm.ShortcutManager manager = getSystemService(android.content.pm.ShortcutManager.class);
        if (manager == null) return null;
        for (android.content.pm.ShortcutInfo shortcut : manager.getDynamicShortcuts()) if (shortcutID.equals(shortcut.getId())) return shortcut.getExtras();
        return null;
    }
}
