export class DropConfirmationRequired extends Error {
  code: 'drop-confirmation';
  dropped: Array<{ key: string; reason: string }>;
  constructor(dropped: Array<{ key: string; reason: string }>);
}

export function inspectAgentConfig(config: unknown): {
  legacy: boolean;
  dropped: Array<{ key: string; reason: string }>;
};

export function convertAgentConfig(config: unknown): {
  frontmatter: Record<string, unknown>;
  body: string;
  legacy: boolean;
  dropped: Array<{ key: string; reason: string }>;
};

export function applyNativePatch(
  current: { frontmatter: Record<string, unknown>; body: string },
  patch: Record<string, unknown>,
): { frontmatter: Record<string, unknown>; body: string };

export function writeAgentDocument(
  existing: { frontmatter?: Record<string, unknown>; body?: string },
  patch: Record<string, unknown>,
  confirmDrop: boolean,
): { frontmatter: Record<string, unknown>; body: string };
