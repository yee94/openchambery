import type { PluginGuiOutput } from '@yuriai/opencode-gui-client';

export type NativeGuiEvent = {
  lease?: string; ipc: string; sequence: number;
} & ({ type: 'state'; available: boolean; state?: unknown } | { type: 'event'; name: string; data: unknown } | { type: 'ended' });

export interface NativeGuiBridge {
  request(action: string, input: Record<string, unknown>): Promise<unknown>;
  subscribe(handler: (event: NativeGuiEvent) => void): () => void;
}

export type NativeGuiActivation = {
  lease: string;
  bundle: PluginGuiOutput['data'];
  os: 'macos' | 'windows' | 'linux';
  app: { version: string; packaged: boolean };
};
