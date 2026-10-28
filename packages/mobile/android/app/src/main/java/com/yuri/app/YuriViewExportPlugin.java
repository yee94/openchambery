package com.yuri.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.pdf.PdfDocument;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.DocumentsContract;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

@CapacitorPlugin(name = "YuriViewExport")
public class YuriViewExportPlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private Task active;
    private Task picker;
    private boolean destroyed;

    private static final class Task {
        final PluginCall call;
        final ViewExportRequest request;
        volatile boolean cancelled;
        boolean committed;
        boolean working;
        boolean finished;
        File file;
        ViewExportRenderer renderer;
        PdfDocument document;

        Task(PluginCall call, ViewExportRequest request) { this.call = call; this.request = request; }
    }

    @Override public void load() {
        // Process death may leave private staging files, but never a recoverable
        // export task. A recreated owner cancels the old picker result.
        worker.execute(() -> {
            File[] files = cacheDirectory().listFiles();
            if (files != null) for (File file : files) {
                if (file.getName().startsWith("view-export-") && file.getName().endsWith(".tmp")) file.delete();
            }
        });
    }

    @PluginMethod public void capabilities(PluginCall call) {
        JSObject limits = new JSObject();
        limits.put("maxHTMLBytes", ViewExportRequest.MAX_HTML_BYTES);
        limits.put("maxWidth", ViewExportRequest.MAX_WIDTH);
        limits.put("maxHeight", ViewExportRequest.MAX_HEIGHT);
        limits.put("maxPixels", ViewExportRequest.MAX_PIXELS);
        JSObject result = new JSObject();
        result.put("version", 1);
        result.put("exportPDF", true);
        result.put("exportLongImage", true);
        result.put("limits", limits);
        call.resolve(result);
    }

    @PluginMethod public void exportPDF(PluginCall call) { begin(call, true); }
    @PluginMethod public void exportLongImage(PluginCall call) { begin(call, false); }

    private void begin(PluginCall call, boolean pdf) {
        ViewExportRequest request;
        try {
            JSONObject data = call.getData();
            JSONObject snapshot = data.optJSONObject("snapshot");
            request = new ViewExportRequest(data.opt("taskId"), snapshot == null ? null : snapshot.opt("html"),
                snapshot == null ? null : snapshot.opt("width"), snapshot == null ? null : snapshot.opt("height"),
                data.opt("filename"), data.has("pageSize") ? data.opt("pageSize") : null, pdf);
        } catch (ViewExportRequest.Failure error) {
            call.reject(error.getMessage(), error.code);
            return;
        } catch (OutOfMemoryError error) {
            call.reject("Snapshot exceeds available memory", "EXPORT_TOO_LARGE");
            return;
        } finally {
            // Bridge.saveInstanceState serializes the entire call. Only the opaque
            // task ID may survive; neither HTML nor unknown large fields enter Binder.
            ArrayList<String> keys = new ArrayList<>();
            Iterator<String> iterator = call.getData().keys();
            while (iterator.hasNext()) keys.add(iterator.next());
            for (String key : keys) if (!key.equals("taskId")) call.getData().remove(key);
        }
        main.post(() -> {
            if (destroyed || getActivity() == null || getActivity().isFinishing()) {
                request.html = null;
                call.reject("Export owner is unavailable", "EXPORT_UNSUPPORTED");
                return;
            }
            if (active != null || picker != null) {
                request.html = null;
                call.reject("Another export is in progress", "EXPORT_BUSY");
                return;
            }
            Task task = new Task(call, request);
            active = task;
            progress(task, "preparing", null, null);
            progress(task, "rendering", null, null);
            task.renderer = new ViewExportRenderer(getActivity(), request, new ViewExportRenderer.Callback() {
                @Override public void ready() {
                    if (!live(task)) return;
                    if (request.pdf) {
                        try {
                            task.document = new PdfDocument();
                            renderPDFPage(task, 0);
                        } catch (RuntimeException | OutOfMemoryError error) {
                            fail(task, "EXPORT_RENDER_FAILED", "Could not allocate the PDF document");
                        }
                    } else renderPNG(task);
                }
                @Override public void failed() { fail(task, "EXPORT_RENDER_FAILED", "Could not render the snapshot"); }
            });
        });
    }

    private void renderPNG(Task task) {
        Bitmap bitmap = null;
        try {
            bitmap = Bitmap.createBitmap(task.request.width, task.request.height, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            canvas.drawColor(Color.WHITE);
            task.renderer.draw(canvas);
            closeRenderer(task);
            progress(task, "encoding", null, null);
            Bitmap output = bitmap;
            task.working = true;
            worker.execute(() -> {
                String failure = null;
                try {
                    checkCancelled(task);
                    task.file = newCacheFile();
                    try (OutputStream stream = new FileOutputStream(task.file)) {
                        if (!output.compress(Bitmap.CompressFormat.PNG, 100, stream)) throw new IOException("PNG encoding failed");
                    }
                    checkCancelled(task);
                } catch (Exception | OutOfMemoryError error) {
                    failure = "Could not encode the image";
                } finally { output.recycle(); }
                encodingFinished(task, failure);
            });
        } catch (RuntimeException | OutOfMemoryError error) {
            if (bitmap != null) bitmap.recycle();
            fail(task, "EXPORT_RENDER_FAILED", "Could not render the complete image");
        }
    }

    private void renderPDFPage(Task task, int index) {
        if (!live(task)) return;
        int width = task.request.letter ? 612 : 595;
        int height = task.request.letter ? 792 : 842;
        int contentWidth = width - 48;
        int contentHeight = height - 48;
        float scale = Math.min(0.75f, (float) contentWidth / task.request.width);
        int pages = (int) Math.ceil(task.request.height * (double) scale / contentHeight);
        PdfDocument.Page page = null;
        try {
            page = task.document.startPage(new PdfDocument.PageInfo.Builder(width, height, index + 1).create());
            Canvas canvas = page.getCanvas();
            canvas.drawColor(Color.WHITE);
            canvas.translate(24, 24);
            canvas.clipRect(0, 0, contentWidth, contentHeight);
            canvas.scale(scale, scale);
            canvas.translate(0, -index * contentHeight / scale);
            // Draw directly to the PDF canvas: text/path operations remain vector
            // operations. A PNG screenshot is never embedded as the PDF document.
            task.renderer.draw(canvas);
        } catch (RuntimeException | OutOfMemoryError error) {
            if (page != null) task.document.finishPage(page);
            fail(task, "EXPORT_RENDER_FAILED", "Could not render the PDF page");
            return;
        }
        task.document.finishPage(page);
        progress(task, "rendering", index + 1L, (long) pages);
        if (index + 1 < pages) {
            // Yield between pages so cancel and Activity teardown can preempt work.
            main.post(() -> renderPDFPage(task, index + 1));
            return;
        }
        closeRenderer(task);
        progress(task, "encoding", null, null);
        PdfDocument document = task.document;
        task.document = null;
        task.working = true;
        worker.execute(() -> {
            String failure = null;
            try {
                checkCancelled(task);
                task.file = newCacheFile();
                try (OutputStream stream = new FileOutputStream(task.file)) { document.writeTo(stream); }
                checkCancelled(task);
            } catch (Exception | OutOfMemoryError error) {
                failure = "Could not encode the PDF";
            } finally { document.close(); }
            encodingFinished(task, failure);
        });
    }

    private void encodingFinished(Task task, String failure) {
        main.post(() -> {
            task.working = false;
            if (task.cancelled || destroyed) finish(task, "cancelled");
            else if (failure != null) fail(task, "EXPORT_RENDER_FAILED", failure);
            else presentPicker(task);
        });
    }

    private void presentPicker(Task task) {
        if (!live(task)) return;
        progress(task, "saving", null, null);
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(task.request.pdf ? "application/pdf" : "image/png");
        intent.putExtra(Intent.EXTRA_TITLE, task.request.filename);
        intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        picker = task;
        try { startActivityForResult(task.call, intent, "saveResult"); }
        catch (RuntimeException error) {
            picker = null;
            fail(task, "EXPORT_SAVE_FAILED", "Could not open the document picker");
        }
    }

    @ActivityCallback private void saveResult(PluginCall call, ActivityResult result) {
        Task task = picker;
        picker = null;
        Uri uri = result != null && result.getResultCode() == Activity.RESULT_OK && result.getData() != null
            ? result.getData().getData() : null;
        if (task == null || task.finished || task.cancelled || destroyed) {
            if (uri != null) worker.execute(() -> deleteDestination(uri));
            if (task != null && !task.finished) finish(task, "cancelled");
            else if (task == null && call != null) call.resolve(status("cancelled"));
            return;
        }
        if (uri == null) { finish(task, "cancelled"); return; }
        if (!"content".equals(uri.getScheme())) {
            fail(task, "EXPORT_SAVE_FAILED", "Invalid document destination");
            return;
        }
        task.working = true;
        worker.execute(() -> {
            String failure = null;
            try {
                checkCancelled(task);
                long total = task.file.length();
                OutputStream opened = getContext().getContentResolver().openOutputStream(uri, "wt");
                if (opened == null) throw new IOException("No document output stream");
                try (OutputStream output = opened; FileInputStream input = new FileInputStream(task.file)) {
                    byte[] buffer = new byte[64 * 1024];
                    long completed = 0;
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        checkCancelled(task);
                        output.write(buffer, 0, count);
                        completed += count;
                        if (completed == total || completed % (1024 * 1024) == 0) {
                            long written = completed;
                            main.post(() -> progress(task, "saving", written, total));
                        }
                    }
                    output.flush();
                }
                // Cancellation and completed writes have one linearization point.
                // saved is impossible before close has succeeded.
                synchronized (task) {
                    checkCancelled(task);
                    task.committed = true;
                }
            } catch (Exception error) {
                deleteDestination(uri);
                failure = "Could not write the document";
            }
            String error = failure;
            main.post(() -> {
                task.working = false;
                if (task.committed) finish(task, "saved");
                else if (task.cancelled || destroyed) finish(task, "cancelled");
                else fail(task, "EXPORT_SAVE_FAILED", error);
            });
        });
    }

    @PluginMethod public void cancel(PluginCall call) {
        String id = call.getString("taskId");
        if (id == null || !id.matches("[A-Za-z0-9_-]{1,128}")) {
            call.reject("Invalid task ID", "EXPORT_INVALID_INPUT");
            return;
        }
        main.post(() -> {
            if (active != null && active.request.taskId.equals(id)) cancelTask(active);
            call.resolve();
        });
    }

    private void cancelTask(Task task) {
        synchronized (task) {
            if (task.committed) return;
            task.cancelled = true;
        }
        closeRenderer(task);
        if (!task.working) finish(task, "cancelled");
        // Keep the picker reservation until its result arrives. Capacitor stores
        // a single last-call ID; a second picker would misassociate late results.
    }

    @Override public Boolean shouldOverrideLoad(Uri url) {
        main.post(() -> { if (active != null) cancelTask(active); });
        return null;
    }

    @Override protected void handleOnDestroy() {
        main.post(() -> {
            destroyed = true;
            if (active != null) cancelTask(active);
            worker.shutdown();
        });
    }

    private boolean live(Task task) { return !destroyed && active == task && !task.cancelled && !task.finished; }

    private void progress(Task task, String stage, Long completed, Long total) {
        if (!live(task)) return;
        JSObject event = new JSObject();
        event.put("taskId", task.request.taskId);
        event.put("stage", stage);
        if (completed != null) event.put("completed", completed);
        if (total != null) event.put("total", total);
        notifyListeners("progress", event);
    }

    private void fail(Task task, String code, String message) {
        if (task.finished) return;
        if (task.working) { cancelTask(task); return; }
        cleanup(task);
        task.call.reject(message, code);
    }

    private void finish(Task task, String result) {
        if (task.finished) return;
        cleanup(task);
        task.call.resolve(status(result));
    }

    private void cleanup(Task task) {
        task.finished = true;
        closeRenderer(task);
        if (task.document != null) { task.document.close(); task.document = null; }
        if (task.file != null) { task.file.delete(); task.file = null; }
        task.request.html = null;
        if (active == task) active = null;
        getBridge().releaseCall(task.call);
    }

    private void closeRenderer(Task task) {
        if (task.renderer != null) { task.renderer.close(); task.renderer = null; }
    }

    private static JSObject status(String status) { JSObject value = new JSObject(); value.put("status", status); return value; }
    private static void checkCancelled(Task task) throws IOException {
        if (task.cancelled) throw new IOException("Export cancelled");
    }
    private File cacheDirectory() { return new File(getContext().getCacheDir(), "view-export"); }
    private File newCacheFile() throws IOException {
        File directory = cacheDirectory();
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Could not create export cache");
        return File.createTempFile("view-export-", ".tmp", directory);
    }
    private void deleteDestination(Uri uri) {
        if (!"content".equals(uri.getScheme())) return;
        try { DocumentsContract.deleteDocument(getContext().getContentResolver(), uri); }
        catch (Exception ignored) {
            // Some cloud providers cannot delete an incomplete newly created document.
            // The caller still receives cancellation/failure, never a successful save.
        }
    }
}
