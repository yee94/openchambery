/**
 * PrimJS / Lynx sideload does not ship TextEncoder / TextDecoder.
 * Install before any module that constructs them at import time
 * (e.g. chat/liveTail), otherwise loadCard fails with ReferenceError and
 * ConnectWelcome never mounts.
 */

function installEncodingPolyfill(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;

  if (typeof g.TextEncoder === 'undefined') {
    g.TextEncoder = class TextEncoder {
      encode(input = ''): Uint8Array {
        const utf8 = unescape(encodeURIComponent(input));
        const out = new Uint8Array(utf8.length);
        for (let i = 0; i < utf8.length; i += 1) out[i] = utf8.charCodeAt(i);
        return out;
      }
      encodeInto(input: string, dest: Uint8Array): { read: number; written: number } {
        const encoded = this.encode(input);
        const written = Math.min(encoded.length, dest.length);
        dest.set(encoded.subarray(0, written));
        return { read: input.length, written };
      }
      get encoding(): string {
        return 'utf-8';
      }
    };
  }

  if (typeof g.TextDecoder === 'undefined') {
    g.TextDecoder = class TextDecoder {
      readonly encoding = 'utf-8';
      readonly fatal = false;
      readonly ignoreBOM = false;
      private pending = '';

      constructor(_label?: string, _options?: TextDecoderOptions) {}

      decode(input?: BufferSource, options?: TextDecodeOptions): string {
        if (input == null) {
          const tail = this.pending;
          this.pending = '';
          return tail;
        }
        const bytes =
          input instanceof ArrayBuffer
            ? new Uint8Array(input)
            : input instanceof Uint8Array
              ? input
              : new Uint8Array((input as ArrayBufferView).buffer);
        let binary = this.pending;
        this.pending = '';
        for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
        // Incomplete trailing multi-byte sequences are rare for our SSE use; keep simple.
        try {
          const decoded = decodeURIComponent(escape(binary));
          if (options?.stream) return decoded;
          return decoded;
        } catch {
          if (options?.stream) {
            this.pending = binary.slice(-3);
            try {
              return decodeURIComponent(escape(binary.slice(0, -this.pending.length)));
            } catch {
              return binary;
            }
          }
          return binary;
        }
      }
    };
  }
}

installEncodingPolyfill();

export {};
