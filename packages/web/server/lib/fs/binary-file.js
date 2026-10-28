const BINARY_SAMPLE_BYTES = 8192;

export const isBinaryFile = async (filePath, fsPromises) => {
  const file = await fsPromises.open(filePath, 'r');
  try {
    const sample = Buffer.alloc(BINARY_SAMPLE_BYTES);
    const { bytesRead } = await file.read(sample, 0, sample.length, 0);
    const bytes = sample.subarray(0, bytesRead);
    if (bytes.includes(0)) return true;
    const { size } = await file.stat();
    try {
      // Only a non-EOF sample may end partway through a UTF-8 code point.
      new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: bytesRead < size });
      return false;
    } catch {
      return true;
    }
  } finally {
    await file.close();
  }
};
