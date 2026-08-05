package com.openchamber.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Writes image bytes into the system gallery (MediaStore). Used by chat image
 * long-press "Save to Photos" so the WebView never depends on navigator.share
 * or a browser download.
 */
@CapacitorPlugin(name = "OpenChamberMedia")
public class OpenChamberMediaPlugin extends Plugin {
    private static final int MAX_BYTES = 32 * 1024 * 1024;

    private final ExecutorService executor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "openchamber-media");
        thread.setDaemon(true);
        return thread;
    });

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
}
