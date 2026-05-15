/**
 * Whisper STT wrapper. One round-trip per user turn.
 *
 * The endpoint takes multipart form data (file + model). We use
 * `whisper-1`; latency is ~1-3 seconds for short recordings, more for
 * long ones. Browser-recorded webm/opus is accepted directly.
 *
 * We never persist user audio: it goes from MediaRecorder to Whisper
 * and the resulting transcript is the durable artifact. This is
 * deliberate — keeps the IndexedDB size sane and respects "voice
 * notes stay private" intuitions.
 */

import { getOpenAIKey } from '@/lib/openai-key';

export async function transcribeAudio(
  blob: Blob,
  opts: { language?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const apiKey = await getOpenAIKey();
  if (!apiKey) {
    throw new Error('OpenAI API key not configured. Add it in Settings to use voice mode.');
  }
  const form = new FormData();
  // The extension matters for some servers; MediaRecorder default is
  // audio/webm. Whisper accepts webm directly.
  const file = new File([blob], 'audio.webm', { type: blob.type || 'audio/webm' });
  form.append('file', file);
  form.append('model', 'whisper-1');
  if (opts.language) form.append('language', opts.language);

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form,
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Whisper HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { text?: string };
  return String(json.text ?? '').trim();
}
