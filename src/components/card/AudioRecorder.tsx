'use client';

import { useEffect, useRef, useState } from 'react';
import { db } from '@/lib/db/dexie';
import { id as ulid } from '@/lib/ulid';
import { cn } from '@/lib/utils';

/**
 * Inline audio recorder for the card editor. Captures via MediaRecorder,
 * stores the blob in the media table, and returns the filename so the
 * caller can embed an `<audio src="filename.webm">` ref into a field.
 *
 * When `transcribe` is true, kicks off Web Speech API recognition in
 * parallel and streams a live transcript out via `onTranscript`. Browser
 * native, free, no API key. Transcription quality varies by browser.
 */
export default function AudioRecorder({
  transcribe,
  onSaved,
  onTranscript,
}: {
  transcribe: boolean;
  onSaved: (filename: string) => void;
  onTranscript?: (text: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string>('');

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    return () => {
      // Cleanup on unmount.
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      streamRef.current?.getTracks().forEach(t => t.stop());
      try { recognitionRef.current?.stop(); } catch { /* ignore */ }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async () => {
    setError(null);
    setTranscript('');
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('Microphone API not available in this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        const mime = chunksRef.current[0]?.type || 'audio/webm';
        const ext = mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : 'audio';
        const blob = new Blob(chunksRef.current, { type: mime });
        const filename = `${ulid()}.${ext}`;
        await db().media.put({
          id: ulid(),
          filename,
          mimeType: mime,
          blob,
        });
        const url = URL.createObjectURL(blob);
        setPreviewUrl(prev => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
        onSaved(filename);
        // Release the mic.
        stream.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      };
      mr.start();
      recorderRef.current = mr;
      setRecording(true);

      if (transcribe) startTranscription();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const stop = () => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
    try { recognitionRef.current?.stop(); } catch { /* ignore */ }
    recognitionRef.current = null;
  };

  const startTranscription = () => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      // Web Speech API isn't implemented in this browser. Just record audio.
      return;
    }
    try {
      const r = new Ctor();
      r.continuous = true;
      r.interimResults = true;
      r.lang = 'en-US';
      r.onresult = (e: SpeechRecognitionEventLike) => {
        let acc = '';
        for (let i = 0; i < e.results.length; i++) {
          acc += e.results[i][0].transcript;
        }
        setTranscript(acc);
        onTranscript?.(acc);
      };
      r.onerror = (e: Event) => {
        // 'no-speech' / 'aborted' aren't worth surfacing.
        const ev = e as { error?: string };
        if (ev.error && ev.error !== 'no-speech' && ev.error !== 'aborted') {
          setError(`Transcription: ${ev.error}`);
        }
      };
      r.start();
      recognitionRef.current = r;
    } catch (e) {
      // Some browsers throw if recognition starts twice — silent fallback.
      if (process.env.NODE_ENV !== 'production') console.warn(e);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        {!recording ? (
          <button
            type="button"
            onClick={start}
            className="text-2xs uppercase tracking-[0.2em] font-light px-3 py-1.5 rounded-lg text-saffron-300 hover:text-saffron-200 hover:bg-saffron-900/15 transition border border-saffron-700/30"
          >
            ● Record
          </button>
        ) : (
          <button
            type="button"
            onClick={stop}
            className="text-2xs uppercase tracking-[0.2em] font-light px-3 py-1.5 rounded-lg text-crimson-200 bg-crimson-900/30 hover:bg-crimson-800/40 transition border border-crimson-700/30 animate-pulse"
          >
            ■ Stop
          </button>
        )}
        {transcribe && (
          <span className="text-2xs uppercase tracking-widest text-dark-500">
            Transcribing live
          </span>
        )}
      </div>

      {previewUrl && !recording && (
        <audio src={previewUrl} controls className="w-full" />
      )}

      {transcript && (
        <div className="text-2xs text-dark-400 font-light italic px-3 py-2 rounded-lg bg-dark-800/30 border border-white/[0.04]">
          “{transcript}”
        </div>
      )}

      {error && (
        <div className={cn('text-2xs font-light', 'text-crimson-300')}>
          {error}
        </div>
      )}
    </div>
  );
}

// Browser Web Speech API has vendor prefixes; we only use the subset of
// SpeechRecognition we touch, so a structural minimum interface is enough.
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: Event) => void) | null;
  start: () => void;
  stop: () => void;
};
type SpeechRecognitionEventLike = {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}
