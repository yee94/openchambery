package com.openchamber.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.content.res.TypedArray;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class ShareReceiverActivity extends Activity {
    static final String SHARE_TARGET_CATEGORY = "com.openchamber.app.SHARE_ASSISTANT";
    static final String ACTION_OPEN_ASSISTANT = "com.openchamber.app.action.OPEN_SHARE_ASSISTANT";

    private static final String STATE_DRAFT_ID = "shareDraftID";
    private static final ExecutorService WORKER = Executors.newCachedThreadPool();
    private static final ConcurrentHashMap<String, WeakReference<ShareReceiverActivity>> ACTIVE = new ConcurrentHashMap<>();

    private String draftID;
    private JSONObject target;
    private String sharedText;
    private final ArrayList<Uri> sharedImages = new ArrayList<>();
    private boolean destroyed;
    private boolean terminalNavigation;

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        Intent intent = getIntent();
        if (ACTION_OPEN_ASSISTANT.equals(intent.getAction())) {
            openMainActivity();
            return;
        }
        if (!readShareIntent(intent)) {
            finish();
            return;
        }

        draftID = state == null ? UUID.randomUUID().toString() : state.getString(STATE_DRAFT_ID);
        if (draftID == null || draftID.isEmpty()) draftID = UUID.randomUUID().toString();
        ACTIVE.put(draftID, new WeakReference<>(this));
        buildInterface();
        prepareDraft();
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putString(STATE_DRAFT_ID, draftID);
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        WeakReference<ShareReceiverActivity> reference = ACTIVE.get(draftID);
        if (reference != null && reference.get() == this) ACTIVE.remove(draftID, reference);
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        cancelDraft();
    }

    private boolean readShareIntent(Intent intent) {
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return false;
        try {
            android.os.PersistableBundle shortcut = shortcutTarget(intent);
            String serverID = shortcut == null ? null : shortcut.getString("serverInstanceID");
            String assistantID = shortcut == null ? null : shortcut.getString("assistantID");
            target = OpenChamberShareStore.defaultTarget(this, serverID, assistantID);
            if (shortcut != null && target != null && (serverID == null || assistantID == null || !serverID.equals(target.optString("serverInstanceID")) || !assistantID.equals(target.optString("assistantID")))) {
                target = null;
            }

            if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
                ArrayList<Uri> streams = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (streams != null) sharedImages.addAll(streams);
            } else {
                Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (stream != null) sharedImages.add(stream);
            }
            ClipData clip = intent.getClipData();
            if (clip != null) {
                for (int index = 0; index < clip.getItemCount(); index++) {
                    Uri uri = clip.getItemAt(index).getUri();
                    if (uri != null && !sharedImages.contains(uri)) sharedImages.add(uri);
                }
            }
            sharedText = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (sharedText == null && clip != null && clip.getItemCount() > 0) {
                CharSequence coerced = clip.getItemAt(0).coerceToText(this);
                if (coerced != null) sharedText = coerced.toString();
            }
            return true;
        } catch (Exception error) {
            target = null;
            sharedText = intent.getStringExtra(Intent.EXTRA_TEXT);
            return true;
        }
    }

    private void prepareDraft() {
        Context context = getApplicationContext();
        String id = draftID;
        JSONObject selectedTarget = target;
        String text = sharedText;
        ArrayList<Uri> images = new ArrayList<>(sharedImages);
        WORKER.execute(() -> {
            try {
                OpenChamberShareStore.prepareDraft(context, id, selectedTarget, text, images);
                dispatchDraftReady(id);
            } catch (Exception error) {
                OpenChamberShareStore.cancelDraft(context, id);
                dispatchFailure(id);
            }
        });
    }

    private void cancelDraft() {
        if (terminalNavigation) return;
        terminalNavigation = true;
        String id = draftID;
        ACTIVE.remove(id);
        Context context = getApplicationContext();
        try {
            OpenChamberShareStore.markDraftCancelled(context, id);
        } catch (Exception ignored) {
        }
        finish();
        WORKER.execute(() -> OpenChamberShareStore.cancelDraft(context, id));
    }

    private void completeShare() {
        if (destroyed || terminalNavigation) return;
        terminalNavigation = true;
        Intent main = new Intent(this, MainActivity.class)
            .setAction(MainActivity.ACTION_SHARE_DRAFT_READY)
            .putExtra("draftID", draftID)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(main);
        ACTIVE.remove(draftID);
        finish();
    }

    private void failShare() {
        if (destroyed || terminalNavigation) return;
        terminalNavigation = true;
        Toast.makeText(this, R.string.share_error_preparing, Toast.LENGTH_LONG).show();
        ACTIVE.remove(draftID);
        finish();
    }

    private void openMainActivity() {
        startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP));
        finish();
    }

    private void buildInterface() {
        int background = resolveColor(android.R.attr.colorBackground, Color.WHITE);
        int foreground = resolveColor(android.R.attr.textColorSecondary, Color.DKGRAY);
        int accent = resolveColor(android.R.attr.colorAccent, foreground);
        int padding = dp(24);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(background);
        root.setPadding(padding, padding, padding, padding);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(
                padding + insets.getSystemWindowInsetLeft(),
                padding + insets.getSystemWindowInsetTop(),
                padding + insets.getSystemWindowInsetRight(),
                padding + insets.getSystemWindowInsetBottom()
            );
            return insets;
        });

        ImageView appIcon = new ImageView(this);
        appIcon.setImageResource(R.mipmap.ic_launcher);
        appIcon.setContentDescription(getString(R.string.share_openchamber_mark));
        root.addView(appIcon, sized(dp(40), dp(40)));

        ProgressBar progress = new ProgressBar(this, null, android.R.attr.progressBarStyleSmall);
        progress.setIndeterminateTintList(ColorStateList.valueOf(accent));
        LinearLayout.LayoutParams progressParams = sized(dp(24), dp(24));
        progressParams.topMargin = dp(24);
        root.addView(progress, progressParams);

        TextView status = new TextView(this);
        status.setText(R.string.share_opening_assistant);
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        status.setTextColor(foreground);
        status.setGravity(Gravity.CENTER);
        status.setSingleLine(true);
        status.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams statusParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        statusParams.topMargin = dp(12);
        root.addView(status, statusParams);

        setContentView(root);
    }

    private android.os.PersistableBundle shortcutTarget(Intent intent) {
        if (android.os.Build.VERSION.SDK_INT < 25) return null;
        String shortcutID = intent.getStringExtra(Intent.EXTRA_SHORTCUT_ID);
        if (shortcutID == null) return null;
        android.content.pm.ShortcutManager manager = getSystemService(android.content.pm.ShortcutManager.class);
        if (manager == null) return null;
        for (android.content.pm.ShortcutInfo shortcut : manager.getDynamicShortcuts()) {
            if (shortcutID.equals(shortcut.getId())) return shortcut.getExtras();
        }
        return null;
    }

    private static void dispatchDraftReady(String id) {
        ShareReceiverActivity activity = activeActivity(id);
        if (activity != null) activity.runOnUiThread(activity::completeShare);
    }

    private static void dispatchFailure(String id) {
        ShareReceiverActivity activity = activeActivity(id);
        if (activity != null) activity.runOnUiThread(activity::failShare);
    }

    private static ShareReceiverActivity activeActivity(String id) {
        WeakReference<ShareReceiverActivity> reference = ACTIVE.get(id);
        ShareReceiverActivity activity = reference == null ? null : reference.get();
        return activity == null || activity.destroyed ? null : activity;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private int resolveColor(int attribute, int fallback) {
        TypedArray attributes = obtainStyledAttributes(new int[]{attribute});
        try {
            return attributes.getColor(0, fallback);
        } finally {
            attributes.recycle();
        }
    }

    private LinearLayout.LayoutParams sized(int width, int height) {
        return new LinearLayout.LayoutParams(width, height);
    }
}
