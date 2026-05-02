/**
 * Web SpeechSynthesis wrapper.
 *
 * Browsers ship `window.speechSynthesis` and `SpeechSynthesisUtterance`
 * built-in. No API key, no network, works offline. Voices are loaded
 * asynchronously by the engine — the first call to `getVoices()` may
 * return an empty array; we wait for the `voiceschanged` event to fire.
 */

export interface SpeakOptions {
  /** voiceURI of the desired voice. Falls back to default when missing. */
  voiceURI?: string;
  /** Playback rate. 0.1 → 10. Most engines clamp meaningful range to ~0.5–2.0. */
  rate?: number;
  /** Pitch. 0 → 2. Default 1. */
  pitch?: number;
  /** Volume. 0 → 1. Default 1. */
  volume?: number;
  /** Called when speech ends naturally or is canceled. */
  onEnd?: () => void;
  /** Called on engine error (network, voice unavailable, etc.). */
  onError?: (e: unknown) => void;
}

/** True when the host browser exposes the speech-synthesis API. */
export function isTtsSupported(): boolean {
  return typeof window !== 'undefined'
    && typeof window.speechSynthesis !== 'undefined'
    && typeof window.SpeechSynthesisUtterance !== 'undefined';
}

/**
 * Load available voices. Returns immediately if the engine has them ready;
 * otherwise waits for `voiceschanged` (with a 1.5s ceiling so callers don't
 * hang forever on browsers that never fire the event).
 */
export function listVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!isTtsSupported()) return Promise.resolve([]);
  const synth = window.speechSynthesis;
  const initial = synth.getVoices();
  if (initial.length > 0) return Promise.resolve(initial);
  return new Promise(resolve => {
    let settled = false;
    const onChange = () => {
      if (settled) return;
      settled = true;
      synth.removeEventListener('voiceschanged', onChange);
      resolve(synth.getVoices());
    };
    synth.addEventListener('voiceschanged', onChange);
    setTimeout(() => {
      if (settled) return;
      settled = true;
      synth.removeEventListener('voiceschanged', onChange);
      resolve(synth.getVoices());
    }, 1500);
  });
}

/**
 * Speak a string. Cancels any in-flight utterance first, so callers don't
 * have to coordinate cleanup. Safe to call when TTS isn't supported (no-op).
 *
 * Returns the utterance so the caller can listen for boundary events if
 * needed (e.g. for word-level highlighting later).
 */
export function speak(text: string, opts: SpeakOptions = {}): SpeechSynthesisUtterance | null {
  if (!isTtsSupported()) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const synth = window.speechSynthesis;
  // Cancel any pending utterance so we don't queue overlapping speech across
  // card flips. The `onend` of the prior utterance fires immediately.
  synth.cancel();

  const u = new window.SpeechSynthesisUtterance(trimmed);
  u.rate = clamp(opts.rate ?? 1, 0.1, 10);
  u.pitch = clamp(opts.pitch ?? 1, 0, 2);
  u.volume = clamp(opts.volume ?? 1, 0, 1);
  if (opts.voiceURI) {
    const voice = synth.getVoices().find(v => v.voiceURI === opts.voiceURI);
    if (voice) u.voice = voice;
  }
  if (opts.onEnd) u.addEventListener('end', () => opts.onEnd?.());
  if (opts.onError) u.addEventListener('error', e => opts.onError?.(e));

  synth.speak(u);
  return u;
}

/** Cancel any in-flight or queued utterance. Safe to call repeatedly. */
export function cancelSpeech(): void {
  if (!isTtsSupported()) return;
  window.speechSynthesis.cancel();
}

/** True when the engine is currently speaking (or paused). */
export function isSpeaking(): boolean {
  if (!isTtsSupported()) return false;
  return window.speechSynthesis.speaking;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
