package com.yuri.app;

public final class RequestHarness {
    interface Action { void run() throws Exception; }
    private static void rejected(String code, Action action) throws Exception {
        try { action.run(); throw new AssertionError("Expected " + code); }
        catch (ViewExportRequest.Failure error) {
            if (!code.equals(error.code)) throw new AssertionError(error.code);
        }
    }
    private static ViewExportRequest request(Object html, Object width, Object height) throws Exception {
        return new ViewExportRequest("task-1", html, width, height, "report", null, false);
    }
    public static void main(String[] args) throws Exception {
        request("a", 8192, 2048);
        request("a", 512, 32768);
        request("a".repeat(16 * 1024 * 1024), 1, 1);
        rejected("EXPORT_TOO_LARGE", () -> request("a", 8193, 1));
        rejected("EXPORT_TOO_LARGE", () -> request("a", 1, 32769));
        rejected("EXPORT_TOO_LARGE", () -> request("a", 8192, 2049));
        rejected("EXPORT_TOO_LARGE", () -> request("中".repeat(6 * 1024 * 1024), 1, 1));
        rejected("EXPORT_TOO_LARGE", () -> request("a".repeat(16 * 1024 * 1024 + 1), 1, 1));
        rejected("EXPORT_INVALID_INPUT", () -> request("a", 0, 1));
        rejected("EXPORT_INVALID_INPUT", () -> request("a", 1.5, 1));
        rejected("EXPORT_INVALID_INPUT", () -> request("a", Double.NaN, 1));
        rejected("EXPORT_INVALID_INPUT", () -> request("a", "320", 1));
        rejected("EXPORT_INVALID_INPUT", () -> request(" ", 1, 1));
        rejected("EXPORT_INVALID_INPUT", () -> new ViewExportRequest("x", "a", 1, 1, "r", "letter", false));
        rejected("EXPORT_INVALID_INPUT", () -> new ViewExportRequest("x", "a", 1, 1, "r", "legal", true));
        rejected("EXPORT_INVALID_INPUT", () -> new ViewExportRequest("../x", "a", 1, 1, "r", null, true));
        for (String html : new String[]{"<SCRIPT>alert(1)</SCRIPT>", "<iframe src='file:///x'>",
            "<meta http-equiv=refresh content='0;url=https://example.invalid'>", "<img onerror = 'run()'>",
            "<link href='https://example.invalid'>", "<object data='x'>"}) {
            rejected("EXPORT_FORBIDDEN", () -> request(html, 1, 1));
        }
        ViewExportRequest png = request("<div style='color:red'>静态</div>", 320, 6000);
        if (!png.filename.equals("report.png")) throw new AssertionError("PNG filename");
        String document = png.document();
        if (document.indexOf("Content-Security-Policy") > document.indexOf("静态")
            || !document.contains("script-src 'none'") || !document.contains("img-src data:")) {
            throw new AssertionError("isolated document policy");
        }
        ViewExportRequest pdf = new ViewExportRequest("x", "a", 320, 6000, "a/b\\c.pdf", "letter", true);
        if (!pdf.letter || !pdf.filename.equals("a_b_c.pdf")) throw new AssertionError("PDF options");
        System.out.println("PASS native validation and isolated document policy");
    }
}
