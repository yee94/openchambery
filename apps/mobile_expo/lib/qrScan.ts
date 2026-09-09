/**
 * Cap scanConnectionQr uses barcode.rawValue ?? displayValue.
 * Expo CameraView primarily exposes `data`; prefer the longest non-empty candidate
 * so a truncated display string cannot win over the full openchamber:// payload.
 */
export const pickScannedQrRaw = (result: {
  data?: string | null;
  raw?: string | null;
  rawValue?: string | null;
  displayValue?: string | null;
}): string => {
  const candidates = [result.rawValue, result.raw, result.data, result.displayValue]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);
  if (candidates.length === 0) return '';
  return candidates.reduce((best, cur) => (cur.length > best.length ? cur : best));
};
