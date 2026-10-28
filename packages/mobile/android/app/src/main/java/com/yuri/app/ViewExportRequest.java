package com.yuri.app;

import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Pattern;

/** Native validation is independent of the caller's capability/limit checks. */
final class ViewExportRequest {
    static final int MAX_HTML_BYTES = 16 * 1024 * 1024;
    static final int MAX_WIDTH = 8192;
    static final int MAX_HEIGHT = 32768;
    static final int MAX_PIXELS = 16 * 1024 * 1024;
    private static final Pattern ACTIVE_TAG = Pattern.compile(
        "<\\s*(?:script|iframe|frame|frameset|object|embed|applet|base|meta|link|video|audio|animate|animateMotion|animateTransform|set)\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern EVENT_ATTRIBUTE = Pattern.compile("\\son[a-z]+\\s*=", Pattern.CASE_INSENSITIVE);

    static final class Failure extends Exception {
        final String code;
        Failure(String code, String message) { super(message); this.code = code; }
    }

    final String taskId;
    final String filename;
    final int width;
    final int height;
    final boolean pdf;
    final boolean letter;
    String html;

    ViewExportRequest(Object taskId, Object html, Object width, Object height,
                      Object filename, Object pageSize, boolean pdf) throws Failure {
        if (!(taskId instanceof String) || !((String) taskId).matches("[A-Za-z0-9_-]{1,128}")) {
            throw new Failure("EXPORT_INVALID_INPUT", "Invalid task ID");
        }
        if (!(html instanceof String) || ((String) html).trim().isEmpty()) {
            throw new Failure("EXPORT_INVALID_INPUT", "A static HTML snapshot is required");
        }
        String text = (String) html;
        if (text.length() > MAX_HTML_BYTES || text.getBytes(StandardCharsets.UTF_8).length > MAX_HTML_BYTES) {
            throw new Failure("EXPORT_TOO_LARGE", "Snapshot exceeds the HTML byte limit");
        }
        this.width = dimension(width, MAX_WIDTH);
        this.height = dimension(height, MAX_HEIGHT);
        if ((long) this.width * this.height > MAX_PIXELS) {
            throw new Failure("EXPORT_TOO_LARGE", "Snapshot exceeds the pixel limit");
        }
        if (!(filename instanceof String) || ((String) filename).trim().isEmpty()
            || ((String) filename).length() > 240) {
            throw new Failure("EXPORT_INVALID_INPUT", "Invalid export filename");
        }
        if (pageSize != null && (!pdf || !("a4".equals(pageSize) || "letter".equals(pageSize)))) {
            throw new Failure("EXPORT_INVALID_INPUT", "Invalid PDF page size");
        }
        if (ACTIVE_TAG.matcher(text).find() || EVENT_ATTRIBUTE.matcher(text).find()) {
            throw new Failure("EXPORT_FORBIDDEN", "Snapshot must contain only static HTML");
        }
        String name = ((String) filename).trim().replaceAll("[\\\\/\\p{Cntrl}]", "_");
        if (name.equals(".") || name.equals("..")) {
            throw new Failure("EXPORT_INVALID_INPUT", "Invalid export filename");
        }
        String extension = pdf ? ".pdf" : ".png";
        this.filename = name.toLowerCase(Locale.ROOT).endsWith(extension) ? name : name + extension;
        this.taskId = (String) taskId;
        this.html = text;
        this.pdf = pdf;
        this.letter = "letter".equals(pageSize);
    }

    private static int dimension(Object value, int maximum) throws Failure {
        if (!(value instanceof Number)) throw new Failure("EXPORT_INVALID_INPUT", "Invalid snapshot dimension");
        double number = ((Number) value).doubleValue();
        if (!Double.isFinite(number) || number < 1 || number != Math.rint(number)) {
            throw new Failure("EXPORT_INVALID_INPUT", "Snapshot dimensions must be positive integers");
        }
        if (number > maximum) throw new Failure("EXPORT_TOO_LARGE", "Snapshot exceeds dimension limits");
        return (int) number;
    }

    String document() {
        // The policy precedes untrusted markup. WebSettings and the request interceptor
        // enforce the same boundary even when malformed markup ignores this policy.
        return "<!doctype html><html><head><meta charset=\"utf-8\">"
            + "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; "
            + "script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; "
            + "connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'\">"
            + "<meta name=\"viewport\" content=\"width=" + width + ",initial-scale=1,maximum-scale=1,user-scalable=no\">"
            + "<style>html,body{margin:0;padding:0;width:" + width + "px;height:" + height
            + "px;overflow:hidden;background:white}*,*::before,*::after{animation:none!important;transition:none!important}</style>"
            + "</head><body>" + html + "</body></html>";
    }
}
