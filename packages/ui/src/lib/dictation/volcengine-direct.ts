import { speechSocketUrl, type SpeechTicket } from '../voice/direct-session';
import { asrFrame, decodeSpeechFrame, openSpeechSocket, speechJson } from '../voice/volcengine-protocol';

export class DirectDictation {
  private socket: Awaited<ReturnType<typeof openSpeechSocket>> | null = null;
  private failure: Error | null = null;
  private completion: Promise<void> | null = null;
  private text = '';
  private final = false;
  private finishing = false;
  private sequence = 0;

  constructor(private readonly abort: AbortController, private readonly partial: (text: string) => void,
    private readonly disconnected: () => void) {}

  get connected(): boolean { return this.socket !== null && !this.failure && !this.abort.signal.aborted; }

  async start(ticket: SpeechTicket, format: string): Promise<void> {
    if (format !== 'audio/pcm;rate=16000;bits=16') throw new Error('Direct speech requires 16 kHz PCM16 audio');
    const socket = await openSpeechSocket(speechSocketUrl(ticket, 'asr'), this.abort.signal);
    this.socket = socket;
    try {
      socket.send(asrFrame(new TextEncoder().encode(JSON.stringify({
        user: { uid: 'yuri' },
        audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
        request: { model_name: 'bigmodel', result_type: 'full', enable_itn: true, enable_punc: true, enable_nonstream: true, show_utterances: true,
          ...(ticket.asrContext?.trim() ? { corpus: { context: JSON.stringify({ context_type: 'dialog_ctx', context_data: [{ text: ticket.asrContext.trim() }] }) } } : {}),
        },
      }))));
    } catch (error) { socket.close(); throw error; }
    this.completion = this.receive().catch((error: unknown) => {
      this.failure = error instanceof Error ? error : new Error('Speech recognition failed');
      socket.close();
      if (!this.abort.signal.aborted && !this.finishing) this.disconnected();
    });
  }

  send(seq: number, base64: string): boolean {
    if (!this.connected || this.finishing || this.final || seq !== this.sequence) return false;
    try {
      if (base64.length > 128000) throw new Error('Speech audio chunk exceeds size limit');
      const binary = atob(base64);
      if (binary.length % 2) throw new Error('Invalid PCM audio');
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      this.socket!.send(asrFrame(bytes, true));
      this.sequence++;
      return true;
    } catch {
      this.failure = new Error('Unable to send speech audio');
      this.socket?.close();
      return false;
    }
  }

  async finish(finalSeq: number): Promise<{ text: string }> {
    if (this.failure) throw this.failure;
    if (!this.socket || finalSeq !== this.sequence - 1) throw new Error('Incomplete speech audio');
    this.finishing = true;
    this.socket.send(asrFrame(new Uint8Array(), true, true));
    const timeout = setTimeout(() => { this.failure = new Error('Speech finalization timed out'); this.socket?.close(); }, 30000);
    try {
      await this.completion;
      this.abort.signal.throwIfAborted();
      if (this.failure) throw this.failure;
      if (!this.final) throw new Error('Incomplete speech recognition');
      return { text: this.text };
    } finally { clearTimeout(timeout); this.socket.close(); }
  }

  cancel(): void { this.abort.abort(); this.socket?.close(); }

  private async receive(): Promise<void> {
    while (true) {
      const frame = await decodeSpeechFrame(await this.socket!.read(), 'asr');
      this.abort.signal.throwIfAborted();
      const message = speechJson(frame.payload);
      if (message.code !== undefined && ![0, 1000, 20000000].includes(Number(message.code))) throw new Error('Speech recognition failed');
      const result = message.result;
      if (result !== undefined && (!result || typeof result !== 'object' || Array.isArray(result))) throw new Error('Invalid speech transcript');
      if (result && typeof result === 'object' && 'text' in result) {
        if (typeof result.text !== 'string') throw new Error('Invalid speech transcript');
        this.text = result.text;
        if (!frame.final) this.partial(this.text);
      }
      if (frame.final) {
        if (!this.finishing) throw new Error('Speech recognition ended unexpectedly');
        this.final = true;
        return;
      }
    }
  }
}
