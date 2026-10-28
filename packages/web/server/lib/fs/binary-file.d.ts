import type * as fsPromises from 'node:fs/promises';

export function isBinaryFile(filePath: string, fs: Pick<typeof fsPromises, 'open'>): Promise<boolean>;
