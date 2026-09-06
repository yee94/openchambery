/**
 * OpenCode-compatible ascending message ID (Cap packages/ui sync/message-id).
 * Format: `${prefix}_` + 12 hex sort bytes + 14 base62 random.
 */

let lastAscendingValue = 0n;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const RANDOM_LENGTH = 14;
const VALUE_MASK = (1n << 48n) - 1n;

const randomBase62 = (length: number): string => {
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += BASE62[Math.floor(Math.random() * 62)]!;
  }
  return result;
};

export const ascendingId = (prefix: string): string => {
  const base = (BigInt(Date.now()) * 0x1000n) & VALUE_MASK;
  const maximum = base > lastAscendingValue ? base : lastAscendingValue;
  if (maximum >= VALUE_MASK) throw new Error('Ascending ID space exhausted');
  const value = maximum + 1n;
  lastAscendingValue = value;
  let hex = '';
  for (let i = 0; i < 6; i += 1) {
    hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn)
      .toString(16)
      .padStart(2, '0');
  }
  return `${prefix}_${hex}${randomBase62(RANDOM_LENGTH)}`;
};
