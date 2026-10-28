package com.yuri.app;

import android.database.Cursor;
import android.database.MatrixCursor;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsProvider;
import java.io.File;
import java.io.FileNotFoundException;

/** Test APK only: a single fixed destination, never an arbitrary file API. */
public final class ViewExportTestDocuments extends DocumentsProvider {
    @Override public boolean onCreate() { return true; }
    @Override public Cursor queryRoots(String[] projection) { return new MatrixCursor(new String[]{"root_id"}); }
    @Override public Cursor queryDocument(String id, String[] projection) { return new MatrixCursor(new String[]{"document_id"}); }
    @Override public Cursor queryChildDocuments(String id, String[] projection, String order) { return new MatrixCursor(new String[]{"document_id"}); }
    @Override public ParcelFileDescriptor openDocument(String id, String mode, CancellationSignal signal) throws FileNotFoundException {
        if (!"destination".equals(id)) throw new FileNotFoundException("Test destination unavailable");
        return ParcelFileDescriptor.open(destination(), ParcelFileDescriptor.parseMode(mode));
    }
    @Override public void deleteDocument(String id) throws FileNotFoundException {
        if (!"destination".equals(id)) throw new FileNotFoundException("Test destination unavailable");
        destination().delete();
    }
    private File destination() { return new File(getContext().getCacheDir(), "view-export-runtime-evidence.pdf"); }
}
