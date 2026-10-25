import type * as fs from 'node:fs/promises';
export function createImageFingerprintReader(filesystem: Pick<typeof fs, 'stat' | 'open'>): (path: string) => Promise<string>;
