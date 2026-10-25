export type StreamPhase = 'streaming' | 'cooldown' | 'completed';

export type DiffViewMode = 'side-by-side' | 'unified';

export interface AgentMentionInfo {
    name: string;
    token: string;
}

export interface ToolPopupContent {
    open: boolean;
    title: string;
    content: string;
    language?: string;
    isDiff?: boolean;
    diffHunks?: Array<Record<string, unknown>>;
    metadata?: Record<string, unknown>;
    previewSource?: HTMLElement;
    video?: { url: string; mimeType?: string; filename?: string; directory?: string };
    image?: {
        url: string;
        /** Originating session/worktree directory, captured when the gallery opens. */
        directory?: string;
        mimeType?: string;
        filename?: string;
        size?: number;
        gallery?: Array<{
            url: string;
            mimeType?: string;
            filename?: string;
            size?: number;
        }>;
        index?: number;
    };
    mermaid?: {
        url: string;
        mimeType?: string;
        filename?: string;
        source?: string;
    };
}
