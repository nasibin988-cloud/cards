/**
 * Push-to-talk recorder built on MediaRecorder.
 *
 * Lifecycle:
 *   const rec = new Recorder();
 *   await rec.start();
 *   // user speaks
 *   const blob = await rec.stop();
 *
 * One Recorder per session; reuse across turns. Microphone permission
 * is requested on first start and held by the running stream so the
 * second turn doesn't need a re-prompt.
 *
 * MediaRecorder default mime is browser-dependent (webm/opus on most
 * desktop browsers, mp4 on Safari). Whisper accepts both, so we don't
 * force a format.
 */

export class Recorder {
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private stopResolver: ((blob: Blob) => void) | null = null;

  async start(): Promise<void> {
    if (this.rec && this.rec.state === 'recording') return;
    if (!this.stream) {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream);
    this.rec.addEventListener('dataavailable', e => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    });
    this.rec.addEventListener('stop', () => {
      const blob = new Blob(this.chunks, { type: this.rec?.mimeType || 'audio/webm' });
      this.chunks = [];
      this.stopResolver?.(blob);
      this.stopResolver = null;
    });
    this.rec.start();
  }

  stop(): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      const r = this.rec;
      if (!r || r.state !== 'recording') {
        reject(new Error('Recorder is not running'));
        return;
      }
      this.stopResolver = resolve;
      r.stop();
    });
  }

  isRecording(): boolean {
    return this.rec?.state === 'recording';
  }

  /** Permanently release the microphone. Call this when the session ends. */
  release(): void {
    try { this.rec?.stop(); } catch { /* */ }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
    }
    this.stream = null;
    this.rec = null;
  }
}
