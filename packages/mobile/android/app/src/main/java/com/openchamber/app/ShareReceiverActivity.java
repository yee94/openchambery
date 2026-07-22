package com.openchamber.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class ShareReceiverActivity extends Activity {
    static final String SHARE_TARGET_CATEGORY = "com.openchamber.app.SHARE_ASSISTANT";
    static final String ACTION_OPEN_ASSISTANT = "com.openchamber.app.action.OPEN_SHARE_ASSISTANT";

    private static final String STATE_DRAFT_ID = "shareDraftID";
    private static final String STATE_PHASE = "sharePhase";
    private static final String STATE_EDITED_TEXT = "shareEditedText";
    private static final String STATE_HAS_EDITED_TEXT = "shareHasEditedText";
    private static final ExecutorService WORKER = Executors.newCachedThreadPool();
    private static final ConcurrentHashMap<String, WeakReference<ShareReceiverActivity>> ACTIVE = new ConcurrentHashMap<>();
    private static final Set<String> PREPARING = Collections.newSetFromMap(new ConcurrentHashMap<>());

    private enum Phase { PREPARING, READY, COMMITTING, CANCELLING, ERROR }

    private String draftID;
    private Phase phase = Phase.PREPARING;
    private JSONObject target;
    private String sharedText;
    private ArrayList<Uri> sharedImages = new ArrayList<>();
    private boolean destroyed;
    private boolean retryPreparesDraft;
    private boolean hasRestoredText;
    private String restoredText;
    private boolean terminalNavigation;

    private TextView assistantAvatar;
    private TextView assistantName;
    private TextView serverLabel;
    private TextView imageCount;
    private LinearLayout previewRow;
    private HorizontalScrollView previewScroll;
    private EditText messageEditor;
    private ProgressBar progress;
    private TextView status;
    private Button cancelButton;
    private Button sendButton;

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
        if (state != null) {
            hasRestoredText = state.getBoolean(STATE_HAS_EDITED_TEXT);
            restoredText = state.getString(STATE_EDITED_TEXT);
        }
        ACTIVE.put(draftID, new WeakReference<>(this));
        buildInterface();
        showTarget(target);
        if (hasRestoredText) messageEditor.setText(restoredText == null ? "" : restoredText);

        if (state == null) {
            prepareDraft();
            return;
        }

        Phase savedPhase = parsePhase(state.getString(STATE_PHASE));
        if (savedPhase == Phase.COMMITTING) {
            phase = Phase.COMMITTING;
            renderState();
            confirmDraft();
            return;
        }
        if (savedPhase == Phase.CANCELLING) {
            cancelDraft();
            return;
        }
        loadDraft();
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putString(STATE_DRAFT_ID, draftID);
        state.putString(STATE_PHASE, phase.name());
        boolean preserveEditedText = phase != Phase.PREPARING;
        state.putBoolean(STATE_HAS_EDITED_TEXT, preserveEditedText);
        if (preserveEditedText) state.putString(STATE_EDITED_TEXT, messageEditor == null ? restoredText : messageEditor.getText().toString());
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
        if (phase == Phase.COMMITTING || phase == Phase.CANCELLING) return;
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
        phase = Phase.PREPARING;
        retryPreparesDraft = true;
        renderState();
        if (!PREPARING.add(draftID)) return;
        Context context = getApplicationContext();
        JSONObject selectedTarget = target;
        String text = sharedText;
        ArrayList<Uri> images = new ArrayList<>(sharedImages);
        WORKER.execute(() -> {
            try {
                OpenChamberShareStore.prepareDraft(context, draftID, selectedTarget, text, images);
                JSONObject draft = OpenChamberShareStore.loadDraft(context, draftID);
                dispatchDraftReady(draftID, draft, loadThumbnails(context, draftID, draft));
            } catch (Exception error) {
                dispatchError(draftID, true, R.string.share_error_preparing);
            } finally {
                PREPARING.remove(draftID);
            }
        });
    }

    private void loadDraft() {
        phase = Phase.PREPARING;
        renderState();
        Context context = getApplicationContext();
        WORKER.execute(() -> {
            try {
                JSONObject draft = OpenChamberShareStore.loadDraft(context, draftID);
                dispatchDraftReady(draftID, draft, loadThumbnails(context, draftID, draft));
            } catch (Exception error) {
                dispatchError(draftID, true, R.string.share_error_preparing);
            }
        });
    }

    private void confirmDraft() {
        phase = Phase.COMMITTING;
        renderState();
        hideKeyboard();
        String editedText = messageEditor.getText().toString();
        Context context = getApplicationContext();
        WORKER.execute(() -> {
            try {
                OpenChamberShareStore.confirmDraft(context, draftID, editedText);
                ShareReceiverActivity activity = activeActivity(draftID);
                if (activity != null) activity.runOnUiThread(activity::completeShare);
            } catch (Exception error) {
                dispatchError(draftID, false, R.string.share_error_sending);
            }
        });
    }

    private void cancelDraft() {
        if (phase == Phase.COMMITTING || phase == Phase.CANCELLING) return;
        phase = Phase.CANCELLING;
        renderState();
        hideKeyboard();
        Context context = getApplicationContext();
        WORKER.execute(() -> {
            try {
                OpenChamberShareStore.cancelDraft(context, draftID);
            } catch (Exception ignored) {
            } finally {
                ShareReceiverActivity activity = activeActivity(draftID);
                if (activity != null) activity.runOnUiThread(activity::finishAfterCancel);
            }
        });
    }

    private void applyDraft(JSONObject draft, ArrayList<Bitmap> thumbnails) {
        if (phase == Phase.CANCELLING) return;
        if (draft == null) {
            showError(true, R.string.share_error_preparing);
            return;
        }
        if (draft.optBoolean("committed")) {
            phase = Phase.COMMITTING;
            renderState();
            completeShare();
            return;
        }
        JSONObject draftTarget = draft.optJSONObject("target");
        if (draftTarget == null && draft.has("name")) draftTarget = draft;
        if (draftTarget == null) draftTarget = target;
        showTarget(draftTarget);
        String draftText = draft.optString("text", "");
        messageEditor.setText(hasRestoredText ? restoredText : draftText);
        messageEditor.setSelection(messageEditor.length());
        hasRestoredText = false;
        renderPreviews(draft.optJSONArray("attachments"), thumbnails);
        retryPreparesDraft = false;
        phase = Phase.READY;
        renderState();
    }

    private void showError(boolean preparationError, int messageID) {
        if (phase == Phase.CANCELLING) return;
        retryPreparesDraft = preparationError;
        phase = Phase.ERROR;
        progress.setVisibility(View.GONE);
        status.setVisibility(View.VISIBLE);
        status.setText(messageID);
        renderState();
    }

    private void completeShare() {
        if (destroyed || terminalNavigation) return;
        terminalNavigation = true;
        Intent main = new Intent(this, MainActivity.class)
            .setAction(MainActivity.ACTION_SHARE_READY)
            .putExtra("operationID", draftID)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(main);
        ACTIVE.remove(draftID);
        finish();
    }

    private void finishAfterCancel() {
        if (terminalNavigation) return;
        terminalNavigation = true;
        ACTIVE.remove(draftID);
        finish();
    }

    private void openMainActivity() {
        startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP));
        finish();
    }

    private void buildInterface() {
        int background = resolveColor(android.R.attr.colorBackground, Color.WHITE);
        int surface = resolveColor(android.R.attr.colorBackgroundFloating, background);
        int foreground = resolveColor(android.R.attr.textColorPrimary, Color.BLACK);
        int secondary = resolveColor(android.R.attr.textColorSecondary, foreground);
        int accent = resolveColor(android.R.attr.colorAccent, foreground);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setClipToPadding(false);
        scroll.setBackgroundColor(background);
        scroll.setPadding(0, dp(8), 0, dp(24));

        FrameLayout stage = new FrameLayout(this);
        scroll.addView(stage, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        CompactColumn column = new CompactColumn(this, dp(560));
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(dp(16), dp(12), dp(16), dp(16));
        FrameLayout.LayoutParams columnParams = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        stage.addView(column, columnParams);

        LinearLayout header = horizontal(Gravity.CENTER_VERTICAL);
        ImageView appMark = new ImageView(this);
        appMark.setImageResource(R.mipmap.ic_launcher);
        appMark.setContentDescription(getString(R.string.share_openchamber_mark));
        header.addView(appMark, sized(dp(32), dp(32)));
        TextView title = text(getString(R.string.share_title), 20, foreground, Typeface.BOLD);
        LinearLayout.LayoutParams titleParams = weighted();
        titleParams.setMarginStart(dp(10));
        header.addView(title, titleParams);
        column.addView(header);

        LinearLayout destinationCard = horizontal(Gravity.CENTER_VERTICAL);
        destinationCard.setPadding(dp(14), dp(12), dp(14), dp(12));
        destinationCard.setBackground(roundRect(surface, dp(16), 0, 0));
        LinearLayout.LayoutParams cardParams = matchWrap();
        cardParams.topMargin = dp(16);
        column.addView(destinationCard, cardParams);

        assistantAvatar = text("O", 18, resolveColor(android.R.attr.textColorPrimaryInverse, Color.WHITE), Typeface.BOLD);
        assistantAvatar.setGravity(Gravity.CENTER);
        assistantAvatar.setBackground(roundRect(accent, dp(24), 0, 0));
        destinationCard.addView(assistantAvatar, sized(dp(48), dp(48)));

        LinearLayout destinationLabels = new LinearLayout(this);
        destinationLabels.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams labelsParams = weighted();
        labelsParams.setMarginStart(dp(12));
        destinationCard.addView(destinationLabels, labelsParams);
        assistantName = text(getString(R.string.share_assistant), 17, foreground, Typeface.BOLD);
        assistantName.setMaxLines(2);
        destinationLabels.addView(assistantName);
        serverLabel = text(getString(R.string.share_missing_target), 14, secondary, Typeface.NORMAL);
        serverLabel.setMaxLines(2);
        destinationLabels.addView(serverLabel);
        TextView direction = text("›", 30, accent, Typeface.NORMAL);
        direction.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        destinationCard.addView(direction, sized(dp(32), dp(48)));

        TextView messageLabel = text(getString(R.string.share_message), 14, secondary, Typeface.BOLD);
        LinearLayout.LayoutParams labelParams = matchWrap();
        labelParams.topMargin = dp(16);
        column.addView(messageLabel, labelParams);

        messageEditor = new EditText(this);
        messageEditor.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        messageEditor.setTextColor(foreground);
        messageEditor.setHintTextColor(secondary);
        messageEditor.setHint(R.string.share_message_hint);
        messageEditor.setGravity(Gravity.TOP | Gravity.START);
        messageEditor.setMinHeight(dp(104));
        messageEditor.setMaxLines(6);
        messageEditor.setPadding(dp(14), dp(12), dp(14), dp(12));
        messageEditor.setBackground(roundRect(surface, dp(14), withAlpha(secondary, 72), dp(1)));
        messageEditor.setContentDescription(getString(R.string.share_message));
        messageEditor.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence value, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence value, int start, int before, int count) { updateSendEnabled(); }
            @Override public void afterTextChanged(Editable value) {}
        });
        LinearLayout.LayoutParams editorParams = matchWrap();
        editorParams.topMargin = dp(7);
        column.addView(messageEditor, editorParams);

        imageCount = text("", 14, secondary, Typeface.BOLD);
        imageCount.setVisibility(View.GONE);
        LinearLayout.LayoutParams countParams = matchWrap();
        countParams.topMargin = dp(14);
        column.addView(imageCount, countParams);

        previewRow = horizontal(Gravity.CENTER_VERTICAL);
        previewScroll = new HorizontalScrollView(this);
        previewScroll.setHorizontalScrollBarEnabled(false);
        previewScroll.addView(previewRow, new HorizontalScrollView.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(76)));
        previewScroll.setVisibility(View.GONE);
        LinearLayout.LayoutParams previewParams = matchWrap();
        previewParams.topMargin = dp(8);
        column.addView(previewScroll, previewParams);

        LinearLayout statusRow = horizontal(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams statusParams = matchWrap();
        statusParams.topMargin = dp(14);
        column.addView(statusRow, statusParams);
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleSmall);
        progress.setIndeterminateTintList(ColorStateList.valueOf(accent));
        statusRow.addView(progress, sized(dp(22), dp(22)));
        status = text(getString(R.string.share_preparing), 14, secondary, Typeface.NORMAL);
        LinearLayout.LayoutParams statusTextParams = weighted();
        statusTextParams.setMarginStart(dp(9));
        statusRow.addView(status, statusTextParams);

        LinearLayout actions = horizontal(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams actionsParams = matchWrap();
        actionsParams.topMargin = dp(16);
        column.addView(actions, actionsParams);
        cancelButton = new Button(this);
        cancelButton.setText(R.string.share_cancel);
        cancelButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        cancelButton.setAllCaps(false);
        cancelButton.setMinHeight(dp(50));
        cancelButton.setOnClickListener(view -> cancelDraft());
        actions.addView(cancelButton, weighted());
        sendButton = new Button(this);
        sendButton.setText(R.string.share_send);
        sendButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        sendButton.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        sendButton.setAllCaps(false);
        sendButton.setMinHeight(dp(50));
        sendButton.setOnClickListener(view -> {
            if (phase == Phase.ERROR && retryPreparesDraft) prepareDraft();
            else if (phase == Phase.READY || phase == Phase.ERROR) confirmDraft();
        });
        LinearLayout.LayoutParams sendParams = weighted();
        sendParams.setMarginStart(dp(12));
        actions.addView(sendButton, sendParams);

        setContentView(scroll);
        renderState();
    }

    private void showTarget(JSONObject value) {
        if (assistantName == null) return;
        String name = value == null ? getString(R.string.share_assistant) : value.optString("name", getString(R.string.share_assistant));
        String server = value == null ? getString(R.string.share_missing_target) : value.optString("serverLabel", getString(R.string.share_missing_target));
        assistantName.setText(name);
        serverLabel.setText(server);
        String initial = name.trim().isEmpty() ? "O" : name.trim().substring(0, 1).toUpperCase(getResources().getConfiguration().getLocales().get(0));
        assistantAvatar.setText(initial);
        assistantAvatar.setContentDescription(getString(R.string.share_assistant_avatar, name));
    }

    private void renderPreviews(JSONArray attachments, ArrayList<Bitmap> thumbnails) {
        previewRow.removeAllViews();
        int count = attachments == null ? 0 : attachments.length();
        imageCount.setVisibility(count == 0 ? View.GONE : View.VISIBLE);
        previewScroll.setVisibility(count == 0 ? View.GONE : View.VISIBLE);
        if (count == 0) return;
        imageCount.setText(getResources().getQuantityString(R.plurals.share_images, count, count));
        for (int index = 0; index < count; index++) {
            JSONObject attachment = attachments.optJSONObject(index);
            if (attachment == null) continue;
            ImageView image = new ImageView(this);
            image.setScaleType(ImageView.ScaleType.CENTER_CROP);
            image.setBackground(roundRect(resolveColor(android.R.attr.colorBackgroundFloating, Color.GRAY), dp(10), 0, 0));
            image.setClipToOutline(true);
            image.setContentDescription(getString(R.string.share_image_preview, index + 1, count));
            Bitmap thumbnail = index < thumbnails.size() ? thumbnails.get(index) : null;
            if (thumbnail != null) image.setImageBitmap(thumbnail);
            LinearLayout.LayoutParams params = sized(dp(76), dp(76));
            if (index > 0) params.setMarginStart(dp(8));
            previewRow.addView(image, params);
        }
    }

    private void renderState() {
        if (progress == null) return;
        boolean busy = phase == Phase.PREPARING || phase == Phase.COMMITTING || phase == Phase.CANCELLING;
        messageEditor.setEnabled(!busy);
        cancelButton.setEnabled(phase != Phase.COMMITTING && phase != Phase.CANCELLING);
        progress.setVisibility(busy ? View.VISIBLE : View.GONE);
        status.setTextColor(resolveColor(android.R.attr.textColorSecondary, Color.DKGRAY));
        if (phase == Phase.PREPARING) {
            status.setVisibility(View.VISIBLE);
            status.setText(R.string.share_preparing);
            sendButton.setText(R.string.share_send);
        } else if (phase == Phase.COMMITTING) {
            status.setVisibility(View.VISIBLE);
            status.setText(R.string.share_sending);
            sendButton.setText(R.string.share_sending_button);
        } else if (phase == Phase.CANCELLING) {
            status.setVisibility(View.VISIBLE);
            status.setText(R.string.share_cancelling);
            sendButton.setText(R.string.share_send);
        } else if (phase == Phase.READY) {
            status.setVisibility(View.GONE);
            sendButton.setText(R.string.share_send);
        } else {
            status.setVisibility(View.VISIBLE);
            status.setTextColor(resolveColor(android.R.attr.colorError, resolveColor(android.R.attr.textColorPrimary, Color.RED)));
            sendButton.setText(retryPreparesDraft ? R.string.share_retry : R.string.share_send);
        }
        updateSendEnabled();
    }

    private void updateSendEnabled() {
        if (sendButton == null) return;
        boolean hasText = messageEditor != null && !messageEditor.getText().toString().trim().isEmpty();
        boolean hasImages = previewRow != null && previewRow.getChildCount() > 0;
        boolean actionableError = phase == Phase.ERROR && (retryPreparesDraft || hasText || hasImages);
        sendButton.setEnabled(phase == Phase.READY && (hasText || hasImages) || actionableError);
    }

    private void hideKeyboard() {
        View focused = getCurrentFocus();
        if (focused == null) return;
        InputMethodManager keyboard = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        keyboard.hideSoftInputFromWindow(focused.getWindowToken(), 0);
        focused.clearFocus();
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

    private static Bitmap sampledBitmap(File file, int requestedWidth, int requestedHeight) {
        if (file == null || !file.isFile()) return null;
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getAbsolutePath(), bounds);
        int sample = 1;
        while (Math.max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= Math.max(requestedWidth, requestedHeight)) sample *= 2;
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sample;
        options.inPreferredConfig = Bitmap.Config.RGB_565;
        return BitmapFactory.decodeFile(file.getAbsolutePath(), options);
    }

    private static ArrayList<Bitmap> loadThumbnails(Context context, String id, JSONObject draft) {
        ArrayList<Bitmap> thumbnails = new ArrayList<>();
        if (draft == null) return thumbnails;
        JSONArray attachments = draft.optJSONArray("attachments");
        int count = attachments == null ? 0 : attachments.length();
        int targetPixels = Math.round(144 * context.getResources().getDisplayMetrics().density);
        for (int index = 0; index < count; index++) {
            Bitmap bitmap = null;
            JSONObject attachment = attachments.optJSONObject(index);
            if (attachment != null) {
                try {
                    File file = OpenChamberShareStore.draftAttachmentFile(context, id, attachment.optString("stagedPath"));
                    bitmap = sampledBitmap(file, targetPixels, targetPixels);
                } catch (Exception ignored) {}
            }
            thumbnails.add(bitmap);
        }
        return thumbnails;
    }

    private static void dispatchDraftReady(String id, JSONObject draft, ArrayList<Bitmap> thumbnails) {
        ShareReceiverActivity activity = activeActivity(id);
        if (activity != null) activity.runOnUiThread(() -> activity.applyDraft(draft, thumbnails));
    }

    private static void dispatchError(String id, boolean preparationError, int messageID) {
        ShareReceiverActivity activity = activeActivity(id);
        if (activity != null) activity.runOnUiThread(() -> activity.showError(preparationError, messageID));
    }

    private static ShareReceiverActivity activeActivity(String id) {
        WeakReference<ShareReceiverActivity> reference = ACTIVE.get(id);
        ShareReceiverActivity activity = reference == null ? null : reference.get();
        return activity == null || activity.destroyed ? null : activity;
    }

    private Phase parsePhase(String value) {
        try { return Phase.valueOf(value); }
        catch (Exception ignored) { return Phase.PREPARING; }
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private int resolveColor(int attribute, int fallback) {
        TypedValue value = new TypedValue();
        return getTheme().resolveAttribute(attribute, value, true) ? value.data : fallback;
    }

    private int withAlpha(int color, int alpha) {
        return Color.argb(alpha, Color.red(color), Color.green(color), Color.blue(color));
    }

    private GradientDrawable roundRect(int color, int radius, int strokeColor, int strokeWidth) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(radius);
        if (strokeWidth > 0) drawable.setStroke(strokeWidth, strokeColor);
        return drawable;
    }

    private TextView text(String value, int size, int color, int style) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, size);
        view.setTextColor(color);
        view.setTypeface(Typeface.DEFAULT, style);
        return view;
    }

    private LinearLayout horizontal(int gravity) {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.HORIZONTAL);
        layout.setGravity(gravity);
        return layout;
    }

    private LinearLayout.LayoutParams weighted() {
        return new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private LinearLayout.LayoutParams sized(int width, int height) {
        return new LinearLayout.LayoutParams(width, height);
    }

    private static final class CompactColumn extends LinearLayout {
        private final int maximumWidth;
        CompactColumn(Context context, int maximumWidth) { super(context); this.maximumWidth = maximumWidth; }
        @Override protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
            int available = MeasureSpec.getSize(widthMeasureSpec);
            int width = Math.min(available, maximumWidth);
            super.onMeasure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), heightMeasureSpec);
        }
    }
}
