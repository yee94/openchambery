package com.openchamber.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.provider.OpenableColumns;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;

final class OpenChamberShareStore {
    static final long MAX_IMAGE_BYTES = 8L * 1024 * 1024;
    static final long MAX_TOTAL_BYTES = 16L * 1024 * 1024;
    static final int MAX_IMAGES = 10;
    static final long TTL_MILLIS = 24L * 60 * 60 * 1000;
    private static final long DRAFT_TTL_MILLIS = 60L * 60 * 1000;
    private static final Object LOCK = new Object();
    private static final String CATALOG = "openchamberShareCatalog";
    private static final String CANCELLATIONS = "openchamber-share-cancellations";

    static File inbox(Context context) { return new File(context.getFilesDir(), "openchamber-share-inbox"); }
    static File drafts(Context context) { return new File(context.getFilesDir(), "openchamber-share-drafts"); }

    static void updateCatalog(Context context, JSONArray catalog) throws Exception {
        context.getSharedPreferences("openchamber-share", Context.MODE_PRIVATE).edit().putString(CATALOG, catalog.toString()).commit();
        refreshShortcuts(context, catalog);
    }

    static JSONObject defaultTarget(Context context, String serverID, String assistantID) throws Exception {
        JSONArray entries = new JSONArray(context.getSharedPreferences("openchamber-share", Context.MODE_PRIVATE).getString(CATALOG, "[]"));
        JSONObject fallback = null;
        for (int i = 0; i < entries.length(); i++) {
            JSONObject entry = entries.getJSONObject(i);
            if (!entry.optBoolean("enabled")) continue;
            if (serverID != null && assistantID != null && serverID.equals(entry.optString("serverInstanceID")) && assistantID.equals(entry.optString("assistantID"))) return entry;
            if (entry.optBoolean("isDefaultShareTarget")) fallback = entry;
        }
        return fallback;
    }

    static JSONObject prepareDraft(Context context, String draftID, JSONObject target, String text, java.util.List<Uri> images) throws Exception {
        requireID(draftID);
        synchronized (LOCK) {
            pruneLocked(context);
            throwIfDraftCancelled(context, draftID);
            JSONObject existing = loadDraftLocked(context, draftID);
            if (existing != null) return existing;
            if (target == null) throw new IllegalStateException("Choose a default share assistant in OpenChamber before sharing.");
            if (images.size() > MAX_IMAGES) throw new IllegalArgumentException("A share supports up to 10 images.");
            if ((text == null || text.trim().isEmpty()) && images.isEmpty()) throw new IllegalArgumentException("Share text or at least one image.");

            File root = drafts(context); root.mkdirs();
            File temp = new File(root, "." + draftID);
            delete(temp);
            if (!temp.mkdirs()) throw new IllegalStateException("Could not prepare shared content.");
            JSONArray attachments = new JSONArray();
            long total = 0;
            try {
                for (int i = 0; i < images.size(); i++) {
                    throwIfDraftCancelled(context, draftID);
                    Uri uri = images.get(i);
                    String mime = context.getContentResolver().getType(uri);
                    if (mime == null || !mime.startsWith("image/")) throw new IllegalArgumentException("Only image attachments are supported.");
                    String name = displayName(context, uri);
                    File output = new File(temp, i + "-" + safeName(name));
                    long size = copyLimited(context.getContentResolver().openInputStream(uri), output, MAX_IMAGE_BYTES);
                    throwIfDraftCancelled(context, draftID);
                    total += size;
                    if (total > MAX_TOTAL_BYTES) throw new IllegalArgumentException("Shared images exceed 16 MB.");
                    attachments.put(new JSONObject().put("stagedPath", output.getName()).put("originalName", name).put("mime", mime).put("byteSize", size));
                }
                long now = System.currentTimeMillis();
                JSONObject draft = new JSONObject().put("target", target).put("text", text == null ? "" : text.trim()).put("attachments", attachments).put("createdAt", now).put("expiresAt", now + DRAFT_TTL_MILLIS);
                writeAtomic(new File(temp, "draft.json"), draft.toString().getBytes(StandardCharsets.UTF_8));
                throwIfDraftCancelled(context, draftID);
                File ready = new File(drafts(context), draftID);
                if (!temp.renameTo(ready)) throw new IllegalStateException("Could not finalize shared draft.");
                return draft;
            } catch (Exception error) {
                delete(temp);
                throw error;
            }
        }
    }

    static JSONObject loadDraft(Context context, String draftID) throws Exception {
        synchronized (LOCK) { requireID(draftID); pruneLocked(context); return loadDraftLocked(context, draftID); }
    }

    static File draftAttachmentFile(Context context, String draftID, String stagedPath) {
        requireID(draftID);
        if (!validPath(stagedPath)) throw new IllegalArgumentException("Invalid staged attachment path.");
        File directory = new File(drafts(context), draftID);
        if (!directory.isDirectory()) directory = new File(inbox(context), draftID);
        return new File(directory, stagedPath);
    }

    static String confirmDraft(Context context, String draftID, String text) throws Exception {
        synchronized (LOCK) {
            requireID(draftID);
            throwIfDraftCancelled(context, draftID);
            pruneLocked(context);
            File inboxDirectory = new File(inbox(context), draftID);
            File inboxEnvelope = new File(inboxDirectory, "envelope.json");
            if (inboxEnvelope.isFile()) {
                JSONObject envelope = readJSON(inboxEnvelope);
                if (draftID.equals(envelope.optString("operationID"))) return draftID;
                throw new IllegalStateException("The shared operation has a different ID.");
            }
            File draftDirectory = new File(drafts(context), draftID);
            File draftFile = new File(draftDirectory, "draft.json");
            if (!draftFile.isFile()) throw new IllegalStateException("The share draft is unavailable.");
            JSONObject draft = readJSON(draftFile);
            if (draft.optLong("expiresAt") <= System.currentTimeMillis() || !validAttachments(draft.optJSONArray("attachments"))) throw new IllegalStateException("The share draft has expired.");
            String finalText = text == null ? "" : text.trim();
            if (finalText.isEmpty() && (draft.optJSONArray("attachments") == null || draft.optJSONArray("attachments").length() == 0)) throw new IllegalArgumentException("Share text or at least one image.");
            draft.put("text", finalText);
            writeAtomic(draftFile, draft.toString().getBytes(StandardCharsets.UTF_8));
            JSONObject target = draft.getJSONObject("target");
            long now = System.currentTimeMillis();
            JSONObject envelope = new JSONObject().put("version", 1).put("operationID", draftID).put("serverInstanceID", target.getString("serverInstanceID")).put("assistantID", target.getString("assistantID")).put("attachments", draft.getJSONArray("attachments")).put("source", "android-share").put("createdAt", now).put("expiresAt", now + TTL_MILLIS);
            if (!finalText.isEmpty()) envelope.put("text", finalText);
            writeAtomic(new File(draftDirectory, "envelope.json"), envelope.toString().getBytes(StandardCharsets.UTF_8));
            inbox(context).mkdirs();
            if (!draftDirectory.renameTo(inboxDirectory)) throw new IllegalStateException("Could not finalize shared content.");
            return draftID;
        }
    }

    static void cancelDraft(Context context, String draftID) {
        markDraftCancelled(context, draftID);
        synchronized (LOCK) { delete(new File(drafts(context), draftID)); }
    }

    static JSONArray pending(Context context) throws Exception {
        synchronized (LOCK) {
            pruneLocked(context);
            JSONArray result = new JSONArray();
            File[] dirs = inbox(context).listFiles();
            if (dirs != null) for (File dir : dirs) {
                File file = new File(dir, "envelope.json");
                if (!dir.isDirectory() || !file.isFile()) continue;
                JSONObject envelope = readJSON(file);
                if (envelope.has("consumedAt")) continue;
                JSONArray attachments = envelope.optJSONArray("attachments");
                if (attachments != null) for (int i = 0; i < attachments.length(); i++) {
                    JSONObject attachment = attachments.getJSONObject(i);
                    String stagedPath = attachment.optString("stagedPath");
                    if (!validPath(stagedPath)) throw new IllegalStateException("Invalid staged attachment path.");
                    attachment.put("stagedPath", new File(dir, stagedPath).getAbsolutePath());
                }
                result.put(envelope);
            }
            return result;
        }
    }

    static JSONArray pendingDrafts(Context context) throws Exception {
        synchronized (LOCK) {
            pruneLocked(context);
            ArrayList<JSONObject> draftsByCreatedAt = new ArrayList<>();
            File[] dirs = drafts(context).listFiles();
            if (dirs != null) for (File dir : dirs) try {
                if (!dir.isDirectory() || !validID(dir.getName())) continue;
                if (isDraftCancelled(context, dir.getName())) {
                    delete(dir);
                    continue;
                }
                JSONObject draft = readJSON(new File(dir, "draft.json"));
                JSONObject target = draft.optJSONObject("target");
                JSONArray attachments = draft.optJSONArray("attachments");
                long createdAt = draft.optLong("createdAt");
                long expiresAt = draft.optLong("expiresAt");
                String text = draft.optString("text", "").trim();
                if (createdAt <= 0 || expiresAt <= createdAt || expiresAt <= System.currentTimeMillis() || !validTarget(target) || !completeAttachments(dir, attachments) || (text.isEmpty() && attachments.length() == 0)) continue;
                JSONArray attachmentCopies = new JSONArray();
                for (int i = 0; i < attachments.length(); i++) {
                    JSONObject attachment = new JSONObject(attachments.getJSONObject(i).toString());
                    attachment.put("stagedPath", new File(dir, attachment.getString("stagedPath")).getAbsolutePath());
                    attachmentCopies.put(attachment);
                }
                JSONObject result = new JSONObject().put("version", 1).put("draftID", dir.getName()).put("serverInstanceID", target.getString("serverInstanceID")).put("assistantID", target.getString("assistantID")).put("name", target.getString("name")).put("avatarSeed", target.getString("avatarSeed")).put("serverLabel", target.getString("serverLabel")).put("connectionKey", target.getString("connectionKey")).put("attachments", attachmentCopies).put("source", "android-share").put("createdAt", createdAt).put("expiresAt", expiresAt);
                if (!text.isEmpty()) result.put("text", text);
                if (isDraftCancelled(context, dir.getName())) {
                    delete(dir);
                    continue;
                }
                draftsByCreatedAt.add(result);
            } catch (Exception ignored) {}
            Collections.sort(draftsByCreatedAt, new Comparator<JSONObject>() { public int compare(JSONObject left, JSONObject right) { return Long.compare(left.optLong("createdAt"), right.optLong("createdAt")); } });
            JSONArray result = new JSONArray();
            for (JSONObject draft : draftsByCreatedAt) result.put(draft);
            return result;
        }
    }

    static void acknowledge(Context context, String operationID) throws Exception {
        synchronized (LOCK) {
            requireID(operationID);
            File file = new File(new File(inbox(context), operationID), "envelope.json");
            if (!file.isFile()) return;
            JSONObject envelope = readJSON(file);
            if (envelope.has("consumedAt")) return;
            envelope.put("consumedAt", System.currentTimeMillis());
            writeAtomic(file, envelope.toString().getBytes(StandardCharsets.UTF_8));
        }
    }

    static void releaseAcknowledged(Context context, String operationID) throws Exception {
        synchronized (LOCK) {
            requireID(operationID);
            File directory = new File(inbox(context), operationID);
            File file = new File(directory, "envelope.json");
            if (!file.isFile()) return;
            if (!readJSON(file).has("consumedAt")) throw new IllegalStateException("The shared operation must be acknowledged before releasing files.");
            delete(directory);
        }
    }

    static void prune(Context context) { synchronized (LOCK) { pruneLocked(context); } }

    private static JSONObject loadDraftLocked(Context context, String draftID) throws Exception {
        File draft = new File(new File(drafts(context), draftID), "draft.json");
        if (draft.isFile()) return readJSON(draft);
        File committedDraft = new File(new File(inbox(context), draftID), "draft.json");
        return committedDraft.isFile() ? readJSON(committedDraft).put("committed", true) : null;
    }

    private static void pruneLocked(Context context) {
        pruneDirectory(drafts(context), "draft.json");
        pruneDirectory(inbox(context), "envelope.json");
        pruneCancelledDrafts(context);
    }

    static void markDraftCancelled(Context context, String draftID) {
        requireID(draftID);
        cancellations(context).edit().putLong(draftID, System.currentTimeMillis() + DRAFT_TTL_MILLIS).commit();
    }

    private static SharedPreferences cancellations(Context context) { return context.getSharedPreferences(CANCELLATIONS, Context.MODE_PRIVATE); }
    private static void throwIfDraftCancelled(Context context, String draftID) {
        if (isDraftCancelled(context, draftID)) throw new IllegalStateException("The share draft was cancelled.");
    }
    private static boolean isDraftCancelled(Context context, String draftID) {
        SharedPreferences cancellations = cancellations(context);
        long expiresAt = cancellations.getLong(draftID, 0);
        if (expiresAt <= System.currentTimeMillis()) {
            if (expiresAt > 0) cancellations.edit().remove(draftID).commit();
            return false;
        }
        return true;
    }
    private static void pruneCancelledDrafts(Context context) {
        SharedPreferences cancellations = cancellations(context);
        SharedPreferences.Editor editor = cancellations.edit();
        long now = System.currentTimeMillis();
        boolean changed = false;
        for (java.util.Map.Entry<String, ?> entry : cancellations.getAll().entrySet()) {
            Object value = entry.getValue();
            if (!(value instanceof Long) || (Long) value <= now) { editor.remove(entry.getKey()); changed = true; }
        }
        if (changed) editor.commit();
    }

    private static void pruneDirectory(File root, String manifest) {
        File[] dirs = root.listFiles(); long now = System.currentTimeMillis();
        if (dirs != null) for (File dir : dirs) try {
            File file = new File(dir, manifest);
            JSONObject value = readJSON(file);
            if (!dir.isDirectory() || dir.getName().startsWith(".") || value.optLong("expiresAt") <= now || !validAttachments(value.optJSONArray("attachments"))) delete(dir);
        } catch (Exception ignored) { delete(dir); }
    }

    private static void requireID(String id) { if (!validID(id)) throw new IllegalArgumentException("A valid draftID is required."); }
    private static boolean validID(String id) { return id != null && id.matches("[A-Za-z0-9-]{1,80}"); }
    private static boolean validPath(String path) { return path != null && !path.isEmpty() && !new File(path).isAbsolute() && !path.contains("/") && !path.contains("\\"); }
    private static boolean validAttachments(JSONArray attachments) throws Exception { if (attachments == null) return true; if (attachments.length() > MAX_IMAGES) return false; long total = 0; for (int i = 0; i < attachments.length(); i++) { JSONObject attachment = attachments.getJSONObject(i); if (!validPath(attachment.optString("stagedPath"))) return false; long size = attachment.optLong("byteSize", -1); if (size < 0 || size > MAX_IMAGE_BYTES) return false; total += size; if (total > MAX_TOTAL_BYTES) return false; } return true; }
    private static boolean completeAttachments(File directory, JSONArray attachments) throws Exception { if (!validAttachments(attachments)) return false; for (int i = 0; i < attachments.length(); i++) { JSONObject attachment = attachments.getJSONObject(i); File file = new File(directory, attachment.getString("stagedPath")); if (!file.isFile() || file.length() != attachment.getLong("byteSize")) return false; } return true; }
    private static boolean validTarget(JSONObject target) { return target != null && nonEmpty(target.optString("serverInstanceID")) && nonEmpty(target.optString("assistantID")) && nonEmpty(target.optString("name")) && nonEmpty(target.optString("avatarSeed")) && nonEmpty(target.optString("serverLabel")) && nonEmpty(target.optString("connectionKey")); }
    private static boolean nonEmpty(String value) { return value != null && !value.trim().isEmpty(); }
    private static JSONObject readJSON(File file) throws Exception { return new JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8)); }
    private static long copyLimited(InputStream input, File output, long maximum) throws Exception { if (input == null) throw new IllegalArgumentException("The shared image could not be read."); long count = 0; byte[] buffer = new byte[32768]; try (InputStream in = input; FileOutputStream out = new FileOutputStream(output)) { int read; while ((read = in.read(buffer)) != -1) { count += read; if (count > maximum) throw new IllegalArgumentException("An image exceeds 8 MB."); out.write(buffer, 0, read); } out.getFD().sync(); } return count; }
    private static String displayName(Context context, Uri uri) { try (android.database.Cursor cursor = context.getContentResolver().query(uri, null, null, null, null)) { if (cursor != null && cursor.moveToFirst()) { int i = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME); if (i >= 0) return cursor.getString(i); } } return "shared-image"; }
    private static String safeName(String name) { return name.replaceAll("[^A-Za-z0-9._-]", "_"); }
    private static void writeAtomic(File file, byte[] bytes) throws Exception { File tmp = new File(file.getParentFile(), "." + file.getName()); try (FileOutputStream out = new FileOutputStream(tmp)) { out.write(bytes); out.getFD().sync(); } if (!tmp.renameTo(file)) throw new IllegalStateException("Could not write share envelope."); }
    private static void delete(File file) { if (file.isDirectory()) { File[] files = file.listFiles(); if (files != null) for (File child : files) delete(child); } file.delete(); }
    private static void refreshShortcuts(Context context, JSONArray entries) { if (android.os.Build.VERSION.SDK_INT < 25) return; java.util.ArrayList<android.content.pm.ShortcutInfo> shortcuts = new java.util.ArrayList<>(); for (int i = 0; i < entries.length() && shortcuts.size() < 4; i++) { try { JSONObject entry = entries.getJSONObject(i); if (!entry.optBoolean("enabled")) continue; String serverID = entry.getString("serverInstanceID"), assistantID = entry.getString("assistantID"), id = "share-" + serverID + "-" + assistantID; android.os.PersistableBundle target = new android.os.PersistableBundle(); target.putString("serverInstanceID", serverID); target.putString("assistantID", assistantID); android.content.Intent launcherIntent = new android.content.Intent(context, ShareReceiverActivity.class).setAction(ShareReceiverActivity.ACTION_OPEN_ASSISTANT).putExtra("serverInstanceID", serverID).putExtra("assistantID", assistantID); shortcuts.add(new android.content.pm.ShortcutInfo.Builder(context, id).setShortLabel(entry.getString("name")).setLongLabel(entry.getString("name") + " · " + entry.optString("serverLabel")).setIcon(android.graphics.drawable.Icon.createWithResource(context, com.openchamber.app.R.mipmap.ic_launcher)).setCategories(java.util.Collections.singleton(ShareReceiverActivity.SHARE_TARGET_CATEGORY)).setExtras(target).setIntent(launcherIntent).build()); } catch (Exception ignored) {} } ((android.content.pm.ShortcutManager) context.getSystemService(android.content.pm.ShortcutManager.class)).setDynamicShortcuts(shortcuts); }
}
