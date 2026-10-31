package com.yuri.app;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.content.ContentUris;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.File;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Dependency-free opt-in instrumentation, run through the Vitest Android entry. */
public final class ViewExportInstrumentation extends Instrumentation {
    private static final int WIDTH = 320;
    private static final int HEIGHT = 6000;
    private MainActivity activity;
    private TestPlugin plugin;

    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            activity = (MainActivity) startActivitySync(new Intent(getTargetContext(), MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            runOnMainSync(() -> { plugin = new TestPlugin(); plugin.setBridge(activity.getBridge()); });
            Call capabilities = new Call("capabilities", new JSObject());
            plugin.capabilities(capabilities);
            require(capabilities.value.getInteger("version") == 1 && capabilities.value.getBoolean("exportPDF")
                && capabilities.value.getBoolean("exportLongImage"), "independent native capabilities");
            Call png = request("png-task", false, null);
            String imageName = "view-export-" + java.util.UUID.randomUUID() + ".png";
            png.getData().put("filename", imageName);
            Call busy = request("busy-task", false, null);
            plugin.exportLongImage(png);
            plugin.exportLongImage(busy);
            await(busy.done);
            require("EXPORT_BUSY".equals(busy.code), "concurrent export must be busy");
            await(png.done);
            require(png.getData().length() == 1 && png.getData().has("taskId"), "Binder payload was not stripped");
            require(png.value != null && "saved".equals(png.value.getString("status")), "PNG must save to gallery");
            require(plugin.presented.getCount() == 1, "PNG must not open a document picker");
            Uri imageUri = galleryImage(imageName);
            Bitmap image;
            try (InputStream input = getTargetContext().getContentResolver().openInputStream(imageUri)) {
                image = BitmapFactory.decodeStream(input);
            }
            require(image != null && image.getWidth() == WIDTH * 2 && image.getHeight() == HEIGHT * 2, "PNG must retain full 2x dimensions");
            require(image.getPixel(20, 20) == Color.RED, "offscreen PNG top is blank/scaled");
            require(image.getPixel(20, 420) == Color.BLUE, "inline data image did not render");
            require(image.getPixel(20, HEIGHT * 2 - 20) == Color.GREEN, "offscreen PNG bottom is blank/truncated");
            for (int x = 60; x < 68; x++) {
                int color = image.getPixel(x, 640);
                require(x % 2 == 0 ? Color.red(color) < 96 : Color.red(color) > 159,
                    "half-CSS-pixel stripes must retain detail instead of enlarging a 1x raster");
            }
            image.recycle();
            getTargetContext().getContentResolver().delete(imageUri, null, null);
            require(cacheFiles().length == 0, "gallery save must delete the staged image");
            Call cancelledImage = request("cancel-image", false, null);
            plugin.cancelOnSave = true;
            plugin.exportLongImage(cancelledImage);
            await(cancelledImage.done);
            require("cancelled".equals(cancelledImage.value.getString("status")), "gallery cancellation status");
            plugin.cancelOnSave = false;
            testPDF(false);
            testPDF(true);
            testPDF(false, 1600);
            testPDF(true, 1600);
            plugin.presented = new CountDownLatch(1);
            Call failedSave = request("failed-save", true, null);
            plugin.exportPDF(failedSave);
            await(plugin.presented);
            pickerResult(failedSave, new ActivityResult(Activity.RESULT_OK, new Intent().setData(destination("unavailable"))));
            await(failedSave.done);
            require("EXPORT_SAVE_FAILED".equals(failedSave.code), "failed document write must reject");
            Call early = request("early", false, null);
            plugin.exportLongImage(early);
            plugin.cancel(new Call("cancel", new JSObject().put("taskId", "early")));
            await(early.done);
            require("cancelled".equals(early.value.getString("status")), "render cancellation status");
            require(cacheFiles().length == 0, "staging cache leaked");
            result.putString("stream", "PASS view export Android runtime; PDF text check "
                + (Build.VERSION.SDK_INT >= 35 ? "executed" : "requires API 35+"));
            finish(Activity.RESULT_OK, result);
        } catch (Throwable error) {
            result.putString("stream", "FAIL " + error);
            finish(Activity.RESULT_CANCELED, result);
        } finally {
            if (plugin != null) runOnMainSync(plugin::handleOnDestroy);
            if (activity != null) runOnMainSync(activity::finish);
        }
    }

    private void testPDF(boolean letter) throws Exception {
        testPDF(letter, WIDTH);
    }

    private Uri galleryImage(String name) {
        Uri collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        try (Cursor cursor = getTargetContext().getContentResolver().query(collection,
                new String[] { MediaStore.Images.Media._ID, MediaStore.Images.Media.IS_PENDING, MediaStore.Images.Media.RELATIVE_PATH },
                MediaStore.Images.Media.DISPLAY_NAME + " = ?", new String[] { name }, null)) {
            require(cursor != null && cursor.moveToFirst(), "saved PNG missing from MediaStore");
            require(cursor.getInt(1) == 0, "saved PNG must not remain pending");
            require("Pictures/Yuri/".equals(cursor.getString(2)), "PNG must be in the Yuri photo album");
            return ContentUris.withAppendedId(collection, cursor.getLong(0));
        }
    }

    private void testPDF(boolean letter, int snapshotWidth) throws Exception {
        plugin.presented = new CountDownLatch(1);
        Call call = request((letter ? "letter-" : "a4-") + snapshotWidth, true, letter ? "letter" : "a4", snapshotWidth);
        plugin.exportPDF(call);
        await(plugin.presented);
        File file = stagedFile();
        try (ParcelFileDescriptor descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
             PdfRenderer pdf = new PdfRenderer(descriptor)) {
            int pageWidth = letter ? 612 : 595;
            int pageHeight = letter ? 792 : 842;
            int contentHeight = pageHeight - 48;
            float scale = Math.min(0.75f, (float) (pageWidth - 48) / snapshotWidth);
            require(pdf.getPageCount() == (snapshotWidth == WIDTH ? (letter ? 7 : 6) : 3), "PDF pagination must exclude 24pt margins");
            try (PdfRenderer.Page first = pdf.openPage(0)) {
                require(first.getWidth() == pageWidth && first.getHeight() == pageHeight, "PDF page size");
                Bitmap pixels = Bitmap.createBitmap(pageWidth, pageHeight, Bitmap.Config.ARGB_8888);
                first.render(pixels, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                require(pixels.getPixel(32, 24) == Color.RED, "PDF content must start at 24pt");
                if (snapshotWidth == WIDTH) {
                    require(pixels.getPixel(263, 32) == Color.RED && pixels.getPixel(265, 32) == Color.WHITE,
                        "320 CSS px must occupy 240pt without enlargement");
                } else {
                    require(pixels.getPixel(pageWidth - 25, 32) == Color.RED && pixels.getPixel(pageWidth - 24, 32) == Color.WHITE,
                        "wide snapshots must shrink to the available page width");
                }
                pixels.recycle();
                if (Build.VERSION.SDK_INT >= 35) {
                    require(!first.searchText("YuriExportSearchable").isEmpty(), "PDF text is not searchable");
                    require(first.searchText("YuriExportSecondPage").isEmpty(), "next-page text leaked onto first page");
                }
            }
            try (PdfRenderer.Page second = pdf.openPage(1)) {
                if (Build.VERSION.SDK_INT >= 35) require(!second.searchText("YuriExportSecondPage").isEmpty(), "second-page text missing");
            }
            for (int index = 0; index < pdf.getPageCount(); index++) {
                try (PdfRenderer.Page page = pdf.openPage(index)) {
                    require(page.getWidth() == pageWidth && page.getHeight() == pageHeight, "all PDF pages must use selected paper size");
                    Bitmap pixels = Bitmap.createBitmap(pageWidth, pageHeight, Bitmap.Config.ARGB_8888);
                    page.render(pixels, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                    for (int y = 0; y < pageHeight; y++) {
                        for (int x = 0; x < pageWidth; x++) {
                            if (x < 24 || x >= pageWidth - 24 || y < 24 || y >= pageHeight - 24) {
                                require(pixels.getPixel(x, y) == Color.WHITE, "PDF content crossed a 24pt page margin");
                            }
                        }
                    }
                    pixels.recycle();
                }
            }
            try (PdfRenderer.Page last = pdf.openPage(pdf.getPageCount() - 1)) {
                Bitmap pixels = Bitmap.createBitmap(last.getWidth(), last.getHeight(), Bitmap.Config.ARGB_8888);
                last.render(pixels, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                int y = 24 + Math.round((HEIGHT - 10) * scale - (pdf.getPageCount() - 1) * contentHeight);
                require(pixels.getPixel(32, y) == Color.GREEN, "PDF last page is blank/truncated");
                if (Build.VERSION.SDK_INT >= 35) {
                    require(!last.searchText("YuriExportLastPage").isEmpty(), "last-page text missing");
                    require(last.searchText("YuriExportSearchable").isEmpty(), "first-page text repeated on last page");
                }
                pixels.recycle();
            }
        }
        if (letter) {
            long bytes = file.length();
            pickerResult(call, new ActivityResult(Activity.RESULT_OK, new Intent().setData(destination("destination"))));
            await(call.done);
            require(call.value != null && "saved".equals(call.value.getString("status")), "successful document write status");
            try (InputStream input = getTargetContext().getContentResolver().openInputStream(destination("destination"))) {
                require(input != null, "saved document must exist");
                long actual = 0;
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) != -1) actual += count;
                require(actual == bytes, "saved must follow complete document write");
            }
            DocumentsContract.deleteDocument(getTargetContext().getContentResolver(), destination("destination"));
        } else {
            pickerCancelled(call);
            await(call.done);
            require("cancelled".equals(call.value.getString("status")), "picker cancellation status");
        }
        require(!file.exists(), "completion must delete staged PDF");
    }

    private void pickerCancelled(Call call) throws Exception {
        pickerResult(call, new ActivityResult(Activity.RESULT_CANCELED, null));
    }

    private static Uri destination(String id) {
        return DocumentsContract.buildDocumentUri("com.yee94.yuri.debug.test.view-export-evidence", id);
    }

    private void pickerResult(Call call, ActivityResult result) throws Exception {
        Method callback = YuriViewExportPlugin.class.getDeclaredMethod("saveResult", PluginCall.class, ActivityResult.class);
        callback.setAccessible(true);
        runOnMainSync(() -> {
            try { callback.invoke(plugin, call, result); }
            catch (Exception error) { throw new RuntimeException(error); }
        });
    }

    private Call request(String id, boolean pdf, String pageSize) {
        return request(id, pdf, pageSize, WIDTH);
    }

    private Call request(String id, boolean pdf, String pageSize, int snapshotWidth) {
        Bitmap pixel = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
        pixel.eraseColor(Color.BLUE);
        ByteArrayOutputStream encoded = new ByteArrayOutputStream();
        pixel.compress(Bitmap.CompressFormat.PNG, 100, encoded);
        pixel.recycle();
        String dataImage = Base64.encodeToString(encoded.toByteArray(), Base64.NO_WRAP);
        String html = "<div style='position:absolute;top:0;width:" + snapshotWidth + "px;height:50px;background:#ff0000'></div>"
            + "<p style='position:absolute;top:100px;color:#000'>YuriExportSearchable</p>"
            + "<img src='data:image/png;base64," + dataImage + "' style='position:absolute;top:200px;width:40px;height:40px'>"
            + "<div style='position:absolute;top:5950px;width:" + snapshotWidth + "px;height:50px;background:#00ff00'></div>";
        if (pdf) {
            double scale = Math.min(0.75, (("letter".equals(pageSize) ? 612 : 595) - 48.0) / snapshotWidth);
            double secondPageTop = (("letter".equals(pageSize) ? 792 : 842) - 48) / scale + 40;
            html += "<div style='position:absolute;left:0;top:0;width:4px;height:6000px;background:#ff8800'></div>"
                + "<p style='position:absolute;left:60px;top:" + secondPageTop + "px;margin:0;color:#000'>YuriExportSecondPage</p>"
                 + "<p style='position:absolute;left:60px;top:5968px;margin:0;font-size:14px;color:#000'>YuriExportLastPage</p>";
        } else {
            html += "<div style='position:absolute;left:30px;top:300px;width:40px;height:40px;background:repeating-linear-gradient(90deg,#000 0px,#000 0.5px,#fff 0.5px,#fff 1px)'></div>";
        }
        JSObject data = new JSObject().put("taskId", id).put("filename", "runtime-evidence")
            .put("snapshot", new JSObject().put("html", html).put("width", snapshotWidth).put("height", HEIGHT));
        if (pageSize != null) data.put("pageSize", pageSize);
        return new Call(pdf ? "exportPDF" : "exportLongImage", data);
    }

    private File[] cacheFiles() { File[] files = new File(getTargetContext().getCacheDir(), "view-export").listFiles(); return files == null ? new File[0] : files; }
    private File stagedFile() { File[] files = cacheFiles(); require(files.length == 1, "one staged file expected"); return files[0]; }
    private static void require(boolean valid, String message) { if (!valid) throw new AssertionError(message); }
    private static void await(CountDownLatch latch) throws Exception { require(latch.await(45, TimeUnit.SECONDS), "native callback timed out"); }

    private static final class TestPlugin extends YuriViewExportPlugin {
        CountDownLatch presented = new CountDownLatch(1);
        boolean cancelOnSave;
        @Override protected void notifyListeners(String event, JSObject data) {
            if (cancelOnSave && "saving".equals(data.optString("stage"))) {
                cancel(new Call("cancel", new JSObject().put("taskId", data.optString("taskId"))));
            }
            super.notifyListeners(event, data);
        }
        @Override public void startActivityForResult(PluginCall call, Intent intent, String name) {
            require(Intent.ACTION_CREATE_DOCUMENT.equals(intent.getAction()), "native document picker intent");
            presented.countDown();
        }
    }

    private static final class Call extends PluginCall {
        final CountDownLatch done = new CountDownLatch(1);
        JSObject value;
        String code;
        Call(String method, JSObject data) { super(null, "YuriViewExport", method + data.optString("taskId"), method, data); }
        @Override public void resolve(JSObject result) { value = result; done.countDown(); }
        @Override public void resolve() { done.countDown(); }
        @Override public void reject(String message, String errorCode) { code = errorCode; done.countDown(); }
    }
}
