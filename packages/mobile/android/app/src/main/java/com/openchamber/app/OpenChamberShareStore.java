package com.openchamber.app;

import android.content.Context;
import android.net.Uri;
import android.provider.OpenableColumns;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.UUID;

final class OpenChamberShareStore {
    static final long MAX_IMAGE_BYTES = 8L * 1024 * 1024;
    static final long MAX_TOTAL_BYTES = 16L * 1024 * 1024;
    static final int MAX_IMAGES = 10;
    static final long TTL_MILLIS = 24L * 60 * 60 * 1000;
    private static final Object LOCK = new Object();
    private static final String CATALOG = "openchamberShareCatalog";

    static File inbox(Context context) { return new File(context.getFilesDir(), "openchamber-share-inbox"); }
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
    static String stage(Context context, JSONObject target, String text, java.util.List<Uri> images) throws Exception {
        synchronized (LOCK) {
            prune(context);
            if (target == null) throw new IllegalStateException("Choose a default share assistant in OpenChamber before sharing.");
            if (images.size() > MAX_IMAGES) throw new IllegalArgumentException("A share supports up to 10 images.");
            if ((text == null || text.trim().isEmpty()) && images.isEmpty()) throw new IllegalArgumentException("Share text or at least one image.");
            String id = UUID.randomUUID().toString(); File root = inbox(context); root.mkdirs(); File temp = new File(root, "." + id); temp.mkdirs();
            JSONArray attachments = new JSONArray(); long total = 0;
            try {
                for (int i = 0; i < images.size(); i++) {
                    Uri uri = images.get(i); String mime = context.getContentResolver().getType(uri);
                    if (mime == null || !mime.startsWith("image/")) throw new IllegalArgumentException("Only image attachments are supported.");
                    String name = displayName(context, uri); File output = new File(temp, i + "-" + safeName(name));
                    long size = copyLimited(context.getContentResolver().openInputStream(uri), output, MAX_IMAGE_BYTES);
                    total += size; if (total > MAX_TOTAL_BYTES) throw new IllegalArgumentException("Shared images exceed 16 MB.");
                    attachments.put(new JSONObject().put("stagedPath", output.getName()).put("originalName", name).put("mime", mime).put("byteSize", size));
                }
                long now = System.currentTimeMillis(); JSONObject envelope = new JSONObject().put("version", 1).put("operationID", id).put("serverInstanceID", target.getString("serverInstanceID")).put("assistantID", target.getString("assistantID")).put("attachments", attachments).put("source", "android-share").put("createdAt", now).put("expiresAt", now + TTL_MILLIS);
                if (text != null && !text.trim().isEmpty()) envelope.put("text", text.trim());
                writeAtomic(new File(temp, "envelope.json"), envelope.toString().getBytes());
                File ready = new File(root, id); if (!temp.renameTo(ready)) throw new IllegalStateException("Could not finalize shared content.");
                return id;
            } catch (Exception error) { delete(temp); throw error; }
        }
    }
    static JSONArray pending(Context context) throws Exception { synchronized (LOCK) { prune(context); JSONArray result = new JSONArray(); File[] dirs = inbox(context).listFiles(); if (dirs != null) for (File dir : dirs) { File file = new File(dir, "envelope.json"); if (!dir.isDirectory() || !file.isFile()) continue; JSONObject envelope = new JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()), java.nio.charset.StandardCharsets.UTF_8)); if (envelope.has("consumedAt")) continue; JSONArray attachments = envelope.optJSONArray("attachments"); if (attachments != null) for (int i = 0; i < attachments.length(); i++) { JSONObject attachment = attachments.getJSONObject(i); String stagedPath = attachment.optString("stagedPath"); if (stagedPath.isEmpty() || new File(stagedPath).isAbsolute()) throw new IllegalStateException("Invalid staged attachment path."); attachment.put("stagedPath", new File(dir, stagedPath).getAbsolutePath()); } result.put(envelope); } return result; } }
    static void acknowledge(Context context, String operationID) throws Exception { synchronized (LOCK) { File file = new File(new File(inbox(context), operationID), "envelope.json"); if (!file.isFile()) return; JSONObject envelope = new JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()), java.nio.charset.StandardCharsets.UTF_8)); if (envelope.has("consumedAt")) return; envelope.put("consumedAt", System.currentTimeMillis()); writeAtomic(file, envelope.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)); } }
    static void remove(Context context, String operationID) { synchronized (LOCK) { delete(new File(inbox(context), operationID)); } }
    static void prune(Context context) { File[] dirs = inbox(context).listFiles(); long now = System.currentTimeMillis(); if (dirs != null) for (File dir : dirs) try { File envelope = new File(dir, "envelope.json"); JSONObject value = new JSONObject(new String(java.nio.file.Files.readAllBytes(envelope.toPath()), java.nio.charset.StandardCharsets.UTF_8)); if (dir.getName().startsWith(".") || !envelope.isFile() || value.optLong("expiresAt") <= now || !validAttachments(value.optJSONArray("attachments"))) delete(dir); } catch (Exception ignored) { delete(dir); } }
    private static boolean validAttachments(JSONArray attachments) throws Exception { if (attachments == null) return true; for (int i = 0; i < attachments.length(); i++) { String stagedPath = attachments.getJSONObject(i).optString("stagedPath"); if (stagedPath.isEmpty() || new File(stagedPath).isAbsolute() || stagedPath.contains("/") || stagedPath.contains("\\")) return false; } return true; }
    private static long copyLimited(InputStream input, File output, long maximum) throws Exception { if (input == null) throw new IllegalArgumentException("The shared image could not be read."); long count = 0; byte[] buffer = new byte[32768]; try (InputStream in = input; FileOutputStream out = new FileOutputStream(output)) { int read; while ((read = in.read(buffer)) != -1) { count += read; if (count > maximum) throw new IllegalArgumentException("An image exceeds 8 MB."); out.write(buffer, 0, read); } out.getFD().sync(); } return count; }
    private static String displayName(Context context, Uri uri) { try (android.database.Cursor cursor = context.getContentResolver().query(uri, null, null, null, null)) { if (cursor != null && cursor.moveToFirst()) { int i = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME); if (i >= 0) return cursor.getString(i); } } return "shared-image"; }
    private static String safeName(String name) { return name.replaceAll("[^A-Za-z0-9._-]", "_"); }
    private static void writeAtomic(File file, byte[] bytes) throws Exception { File tmp = new File(file.getParentFile(), "." + file.getName()); try (FileOutputStream out = new FileOutputStream(tmp)) { out.write(bytes); out.getFD().sync(); } if (!tmp.renameTo(file)) throw new IllegalStateException("Could not write share envelope."); }
    private static void delete(File file) { if (file.isDirectory()) { File[] files = file.listFiles(); if (files != null) for (File child : files) delete(child); } file.delete(); }
    private static void refreshShortcuts(Context context, JSONArray entries) { if (android.os.Build.VERSION.SDK_INT < 25) return; java.util.ArrayList<android.content.pm.ShortcutInfo> shortcuts = new java.util.ArrayList<>(); for (int i = 0; i < entries.length() && shortcuts.size() < 4; i++) { try { JSONObject entry = entries.getJSONObject(i); if (!entry.optBoolean("enabled")) continue; String serverID = entry.getString("serverInstanceID"), assistantID = entry.getString("assistantID"), id = "share-" + serverID + "-" + assistantID; android.os.PersistableBundle target = new android.os.PersistableBundle(); target.putString("serverInstanceID", serverID); target.putString("assistantID", assistantID); android.content.Intent launcherIntent = new android.content.Intent(context, ShareReceiverActivity.class).setAction(ShareReceiverActivity.ACTION_OPEN_ASSISTANT).putExtra("serverInstanceID", serverID).putExtra("assistantID", assistantID); shortcuts.add(new android.content.pm.ShortcutInfo.Builder(context, id).setShortLabel(entry.getString("name")).setLongLabel(entry.getString("name") + " · " + entry.optString("serverLabel")).setIcon(android.graphics.drawable.Icon.createWithResource(context, com.openchamber.app.R.mipmap.ic_launcher)).setCategories(java.util.Collections.singleton(ShareReceiverActivity.SHARE_TARGET_CATEGORY)).setExtras(target).setIntent(launcherIntent).build()); } catch (Exception ignored) {} } ((android.content.pm.ShortcutManager) context.getSystemService(android.content.pm.ShortcutManager.class)).setDynamicShortcuts(shortcuts); }
}
