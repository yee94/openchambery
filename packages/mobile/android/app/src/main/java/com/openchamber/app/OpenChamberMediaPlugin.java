package com.openchamber.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native media/file writes so the WebView never depends on navigator.share
 * or a browser download: saveImage writes to the gallery; saveFile opens
 * ACTION_CREATE_DOCUMENT. transcode converts HEIC/HEIF bytes to JPEG via
 * BitmapFactory on a background executor. pickMedia opens the Android photo picker.
 */
@CapacitorPlugin(name = "OpenChamberMedia")
public class OpenChamberMediaPlugin extends Plugin {
    private static final int MAX_BYTES = 32 * 1024 * 1024;
    private byte[] pendingSaveBytes;

    private final ExecutorService executor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "openchamber-media");
        thread.setDaemon(true);
        return thread;
    });

    @PluginMethod
    public void transcode(PluginCall call) {
        String dataBase64 = call.getString("data");
        if (dataBase64 == null || dataBase64.isEmpty()) {
            call.reject("data is required");
            return;
        }
        int comma = dataBase64.indexOf(',');
        if (dataBase64.regionMatches(true, 0, "data:", 0, 5) && comma >= 0) {
            dataBase64 = dataBase64.substring(comma + 1);
        }
        String mime = call.getString("mime");
        if (mime == null || mime.trim().isEmpty()) {
            call.reject("mime is required");
            return;
        }
        mime = mime.trim().toLowerCase(Locale.ROOT);
        if (!"image/heic".equals(mime) && !"image/heif".equals(mime)) {
            call.reject("Unsupported image type: " + mime);
            return;
        }
        final String finalBase64 = dataBase64;
        final int quality = clampJpegQuality(call.getDouble("quality"));
        // Decode/compress is CPU and memory bound; keep it off the Capacitor bridge thread.
        executor.execute(() -> {
            try {
                byte[] bytes = Base64.decode(finalBase64, Base64.DEFAULT);
                if (bytes == null || bytes.length == 0) {
                    call.reject("Image data is empty or invalid base64");
                    return;
                }
                if (bytes.length > MAX_BYTES) {
                    call.reject("Image exceeds maximum size");
                    return;
                }
                Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (bitmap == null) {
                    call.reject("Could not decode HEIC/HEIF image");
                    return;
                }
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                boolean compressed = bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out);
                bitmap.recycle();
                if (!compressed || out.size() == 0) {
                    call.reject("Could not encode JPEG");
                    return;
                }
                JSObject result = new JSObject();
                result.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
                result.put("mime", "image/jpeg");
                call.resolve(result);
            } catch (Exception error) {
                call.reject(error.getMessage() != null ? error.getMessage() : "Transcode failed", error);
            }
        });
    }

    @PluginMethod
    public void saveImage(PluginCall call) {
        String dataBase64 = call.getString("dataBase64");
        if (dataBase64 == null || dataBase64.isEmpty()) {
            call.reject("dataBase64 is required");
            return;
        }
        // Allow data-URL prefix if the caller passes a full data:image/...;base64, payload.
        int comma = dataBase64.indexOf(',');
        if (dataBase64.regionMatches(true, 0, "data:", 0, 5) && comma >= 0) {
            dataBase64 = dataBase64.substring(comma + 1);
        }

        String mimeType = call.getString("mimeType", "image/png");
        if (mimeType == null || mimeType.isEmpty() || !mimeType.startsWith("image/")) {
            mimeType = "image/png";
        }
        mimeType = mimeType.split(";")[0].trim().toLowerCase();

        String filename = call.getString("filename", "image.png");
        filename = sanitizeFilename(filename, mimeType);

        final String finalBase64 = dataBase64;
        final String finalMime = mimeType;
        final String finalName = filename;

        executor.execute(() -> {
            try {
                byte[] bytes = Base64.decode(finalBase64, Base64.DEFAULT);
                if (bytes == null || bytes.length == 0) {
                    call.reject("Image data is empty");
                    return;
                }
                if (bytes.length > MAX_BYTES) {
                    call.reject("Image exceeds maximum size");
                    return;
                }
                Uri uri = insertImage(bytes, finalName, finalMime);
                if (uri == null) {
                    call.reject("Could not write image to gallery");
                    return;
                }
                call.resolve();
            } catch (Exception error) {
                call.reject(error.getMessage() != null ? error.getMessage() : "Save failed", error);
            }
        });
    }

    @PluginMethod
    public void saveFile(PluginCall call) {
        String dataBase64 = call.getString("dataBase64");
        if (dataBase64 == null || dataBase64.isEmpty()) {
            call.reject("dataBase64 is required");
            return;
        }
        int comma = dataBase64.indexOf(',');
        if (dataBase64.regionMatches(true, 0, "data:", 0, 5) && comma >= 0) {
            dataBase64 = dataBase64.substring(comma + 1);
        }

        String mimeType = call.getString("mimeType", "application/json");
        if (mimeType == null || mimeType.isEmpty()) {
            mimeType = "application/json";
        }
        mimeType = mimeType.split(";")[0].trim();

        String filename = sanitizeExportFilename(call.getString("filename", "export.json"));

        byte[] bytes;
        try {
            bytes = Base64.decode(dataBase64, Base64.DEFAULT);
        } catch (Exception error) {
            call.reject("File data is empty or invalid base64");
            return;
        }
        if (bytes == null || bytes.length == 0) {
            call.reject("File data is empty");
            return;
        }
        if (bytes.length > MAX_BYTES) {
            call.reject("File exceeds maximum size");
            return;
        }

        pendingSaveBytes = bytes;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mimeType);
        intent.putExtra(Intent.EXTRA_TITLE, filename);
        startActivityForResult(call, intent, "saveFileResult");
    }

    @ActivityCallback
    private void saveFileResult(PluginCall call, ActivityResult result) {
        byte[] bytes = pendingSaveBytes;
        pendingSaveBytes = null;
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }
        if (bytes == null || bytes.length == 0) {
            call.reject("File data is empty");
            return;
        }
        Uri uri = result.getData().getData();
        try (OutputStream out = getContext().getContentResolver().openOutputStream(uri)) {
            if (out == null) {
                call.reject("Could not open destination");
                return;
            }
            out.write(bytes);
            out.flush();
        } catch (Exception error) {
            call.reject(error.getMessage() != null ? error.getMessage() : "Save failed", error);
            return;
        }
        JSObject saved = new JSObject();
        saved.put("cancelled", false);
        call.resolve(saved);
    }

    private static String sanitizeExportFilename(String raw) {
        String name = raw == null ? "" : raw.trim();
        if (name.isEmpty()) name = "export.json";
        name = name.replaceAll("[\\\\/]+", "_").replaceAll("[^A-Za-z0-9._\\- ()\\[\\]]+", "_");
        if (!name.matches("(?i).+\\.[a-z0-9]{1,8}$")) {
            name = name + ".json";
        }
        return name;
    }

    private Uri insertImage(byte[] bytes, String filename, String mimeType) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, filename);
        values.put(MediaStore.Images.Media.MIME_TYPE, mimeType);

        Uri collection;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/OpenChamber");
            values.put(MediaStore.Images.Media.IS_PENDING, 1);
            collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        } else {
            collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
        }

        Uri uri = resolver.insert(collection, values);
        if (uri == null) return null;

        try (OutputStream out = resolver.openOutputStream(uri)) {
            if (out == null) {
                resolver.delete(uri, null, null);
                return null;
            }
            out.write(bytes);
            out.flush();
        } catch (Exception error) {
            resolver.delete(uri, null, null);
            throw error;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues done = new ContentValues();
            done.put(MediaStore.Images.Media.IS_PENDING, 0);
            resolver.update(uri, done, null, null);
        }
        return uri;
    }

    private static int clampJpegQuality(Double raw) {
        double value = raw == null ? 0.9 : raw;
        if (Double.isNaN(value) || Double.isInfinite(value)) value = 0.9;
        if (value < 0.0) value = 0.0;
        if (value > 1.0) value = 1.0;
        return (int) Math.round(value * 100.0);
    }

    private static String sanitizeFilename(String raw, String mimeType) {
        String name = raw == null ? "" : raw.trim();
        if (name.isEmpty()) name = "image";
        name = name.replaceAll("[\\\\/]+", "_").replaceAll("[^A-Za-z0-9._\\- ()\\[\\]]+", "_");
        if (!name.matches("(?i).+\\.[a-z0-9]{1,8}$")) {
            String ext = "png";
            if ("image/jpeg".equals(mimeType) || "image/jpg".equals(mimeType)) ext = "jpg";
            else if ("image/webp".equals(mimeType)) ext = "webp";
            else if ("image/gif".equals(mimeType)) ext = "gif";
            name = name + "." + ext;
        }
        return name;
    }

    @PluginMethod
    public void pickMedia(PluginCall call) {
        Integer rawLimit = call.getInt("limit");
        int limit = rawLimit == null ? 20 : rawLimit;
        int maxLimit = 100;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            try {
                int systemMax = MediaStore.getPickImagesMaxLimit();
                if (systemMax > 0) maxLimit = systemMax;
            } catch (Exception ignored) {
                maxLimit = 100;
            }
        }
        if (limit < 1) limit = 1;
        if (limit > maxLimit) limit = maxLimit;

        Intent intent = new Intent(MediaStore.ACTION_PICK_IMAGES);
        intent.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, limit);
        try {
            startActivityForResult(call, intent, "pickMediaResult");
        } catch (ActivityNotFoundException primaryError) {
            Intent fallback = new Intent(Intent.ACTION_GET_CONTENT);
            fallback.addCategory(Intent.CATEGORY_OPENABLE);
            fallback.setType("image/*");
            fallback.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            fallback.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try {
                startActivityForResult(call, fallback, "pickMediaFallbackResult");
            } catch (ActivityNotFoundException fallbackError) {
                call.reject(
                    fallbackError.getMessage() != null ? fallbackError.getMessage() : "Photo picker is unavailable",
                    fallbackError
                );
            }
        }
    }

    @ActivityCallback
    private void pickMediaResult(PluginCall call, ActivityResult result) {
        resolvePickMedia(call, result);
    }

    @ActivityCallback
    private void pickMediaFallbackResult(PluginCall call, ActivityResult result) {
        resolvePickMedia(call, result);
    }

    private void resolvePickMedia(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.resolve(cancelledPickMedia());
            return;
        }

        ArrayList<Uri> uris = new ArrayList<>();
        ClipData clip = result.getData().getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri uri = clip.getItemAt(i).getUri();
                if (uri != null) uris.add(uri);
            }
        } else if (result.getData().getData() != null) {
            uris.add(result.getData().getData());
        }

        executor.execute(() -> {
            try {
                File dir = new File(getContext().getCacheDir(), "pick-media");
                clearPickMediaCache(dir);
                if (!dir.exists() && !dir.mkdirs()) {
                    call.reject("Could not create pick-media cache");
                    return;
                }
                ContentResolver resolver = getContext().getContentResolver();
                JSArray files = new JSArray();
                for (Uri uri : uris) {
                    try {
                        JSObject file = copyPickedMedia(resolver, uri, dir);
                        if (file != null) files.put(file);
                    } catch (Exception ignored) {
                        // One failed file must not erase the rest.
                    }
                }
                JSObject resolved = new JSObject();
                resolved.put("cancelled", false);
                resolved.put("files", files);
                call.resolve(resolved);
            } catch (Exception error) {
                call.reject(error.getMessage() != null ? error.getMessage() : "Pick media failed", error);
            }
        });
    }

    private static JSObject cancelledPickMedia() {
        JSObject cancelled = new JSObject();
        cancelled.put("cancelled", true);
        cancelled.put("files", new JSArray());
        return cancelled;
    }

    private static JSObject copyPickedMedia(ContentResolver resolver, Uri uri, File dir) throws Exception {
        String displayName = null;
        try (Cursor cursor = resolver.query(
            uri,
            new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE },
            null,
            null,
            null
        )) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (nameIndex >= 0 && !cursor.isNull(nameIndex)) {
                    displayName = cursor.getString(nameIndex);
                }
            }
        }

        String mimeType = resolver.getType(uri);
        if (mimeType == null || mimeType.trim().isEmpty()) {
            mimeType = mimeFromExtension(extensionOf(displayName));
            if (mimeType == null) mimeType = "image/jpeg";
        }

        String ext = extensionOf(displayName);
        if ((ext == null || ext.isEmpty()) && mimeType.startsWith("image/")) {
            ext = "jpg";
        }
        String destName = UUID.randomUUID().toString();
        if (ext != null && !ext.isEmpty()) {
            destName = destName + "." + ext;
        }
        File dest = new File(dir, destName);
        try (InputStream in = resolver.openInputStream(uri); FileOutputStream out = new FileOutputStream(dest)) {
            if (in == null) {
                dest.delete();
                return null;
            }
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            out.flush();
        } catch (Exception error) {
            dest.delete();
            throw error;
        }

        String name = displayName != null && !displayName.trim().isEmpty() ? displayName : dest.getName();
        JSObject file = new JSObject();
        file.put("path", dest.getAbsolutePath());
        file.put("name", name);
        file.put("mimeType", mimeType);
        file.put("size", dest.length());
        return file;
    }

    private static void clearPickMediaCache(File dir) {
        if (dir.isFile()) {
            dir.delete();
            return;
        }
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File child : children) {
            deleteQuietly(child);
        }
    }

    private static void deleteQuietly(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) deleteQuietly(child);
            }
        }
        file.delete();
    }

    private static String extensionOf(String name) {
        if (name == null) return null;
        int slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
        String base = slash >= 0 ? name.substring(slash + 1) : name;
        int dot = base.lastIndexOf('.');
        if (dot <= 0 || dot == base.length() - 1) return null;
        String ext = base.substring(dot + 1).trim();
        if (ext.isEmpty() || ext.length() > 8) return null;
        return ext;
    }

    private static String mimeFromExtension(String ext) {
        if (ext == null || ext.isEmpty()) return null;
        String lower = ext.toLowerCase(Locale.ROOT);
        if ("jpg".equals(lower) || "jpeg".equals(lower)) return "image/jpeg";
        if ("png".equals(lower)) return "image/png";
        if ("gif".equals(lower)) return "image/gif";
        if ("webp".equals(lower)) return "image/webp";
        if ("heic".equals(lower)) return "image/heic";
        if ("heif".equals(lower)) return "image/heif";
        if ("bmp".equals(lower)) return "image/bmp";
        if ("avif".equals(lower)) return "image/avif";
        return null;
    }
}
