import type { Express } from "express";
import type { Server } from "http";

export interface WebUiServerController {
  expressApp: Express;
  httpServer: Server;
  getPort: () => number | null;
  getOpenCodePort: () => number | null;
  isReady: () => boolean;
  restartOpenCode: () => Promise<void>;
  stop: (options?: { exitProcess?: boolean; forceCloseConnections?: boolean }) => Promise<void>;
}

export interface StartWebUiServerOptions {
  port?: number;
  host?: string;
  attachSignals?: boolean;
  exitOnShutdown?: boolean;
  uiPassword?: string | null;
  sessionIndexDbPath?: string | null;
  transcriptCacheDbPath?: string | null;
  messageQueueDbPath?: string | null;
  messageQueueAttachmentRoot?: string | null;
  /**
   * Optional process-local lock for settings persistence (Electron in-process).
   * When provided, every settings write/migrate joins this exclusive chain so
   * concurrent desktop writers cannot clobber sibling fields in settings.json.
   */
  settingsPersistLock?: <T>(work: () => Promise<T> | T) => Promise<T>;
}

export declare function startWebUiServer(
  options?: StartWebUiServerOptions
): Promise<WebUiServerController>;

export declare function gracefulShutdown(options?: { exitProcess?: boolean; forceCloseConnections?: boolean }): Promise<void>;
export declare function setupProxy(app: Express): void;
export declare function restartOpenCode(): Promise<void>;
export declare function parseArgs(argv?: string[]): {
  port: number;
  host?: string;
  uiPassword: string | null;
};
