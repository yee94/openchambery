/** Client-container capabilities. These never execute plugin main code. */
export interface ViewExportSnapshot {
    /** Static, self-contained HTML fragment with inline styles and data: assets. */
    html: string;
    width: number;
    height: number;
}

export interface ViewExportLimits {
    maxHTMLBytes: number;
    maxWidth: number;
    maxHeight: number;
    maxPixels: number;
}

export interface ExportPDFInput {
    snapshot: ViewExportSnapshot;
    filename: string;
    pageSize?: 'a4' | 'letter';
}

export interface ExportLongImageInput {
    snapshot: ViewExportSnapshot;
    filename: string;
}

export interface ViewExportProgress {
    stage: 'preparing' | 'rendering' | 'encoding' | 'saving';
    completed?: number;
    total?: number;
}

export interface ViewExportOptions {
    signal?: AbortSignal;
    onProgress?: (progress: ViewExportProgress) => void;
}

export type ViewExportResult = { status: 'saved' | 'cancelled' };

export interface ExportPDFAPI {
    version: 1;
    limits: ViewExportLimits;
    exportPDF(input: ExportPDFInput, options?: ViewExportOptions): Promise<ViewExportResult>;
}

export interface ExportLongImageAPI {
    version: 1;
    limits: ViewExportLimits;
    exportLongImage(input: ExportLongImageInput, options?: ViewExportOptions): Promise<ViewExportResult>;
}

export interface ViewExportCapabilities {
    version: 1;
    exportPDF: boolean;
    exportLongImage: boolean;
    limits: ViewExportLimits;
}

export type ViewExportMethod = 'exportPDF' | 'exportLongImage';
export type ViewExportRequest = (ExportPDFInput | ExportLongImageInput) & { taskId: string };
export type ViewExportEvent = ViewExportProgress & { taskId: string };

export type ViewExportErrorCode = 'EXPORT_UNSUPPORTED' | 'EXPORT_INVALID_INPUT' | 'EXPORT_TOO_LARGE'
    | 'EXPORT_BUSY' | 'EXPORT_ABORTED' | 'EXPORT_RENDER_FAILED' | 'EXPORT_SAVE_FAILED' | 'EXPORT_FORBIDDEN';

export type ViewExportReply = { ok: true; value: unknown } | { ok: false; error: { code: ViewExportErrorCode; message: string } };

/** Narrow preload boundary, available to the app document even on remote runtimes. */
export interface DesktopViewExportBridge {
    request(method: 'capabilities' | ViewExportMethod | 'cancel', input?: unknown): Promise<ViewExportReply>;
    subscribe(listener: (event: ViewExportEvent) => void): () => void;
}

export interface ViewExportAPI {
    capabilities(): Promise<ViewExportCapabilities>;
    exportPDF(input: ExportPDFInput, options?: ViewExportOptions): Promise<ViewExportResult>;
    exportLongImage(input: ExportLongImageInput, options?: ViewExportOptions): Promise<ViewExportResult>;
}
