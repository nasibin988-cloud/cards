'use client';

/**
 * Settings panel for read-aloud (TTS). Persists everything as discrete
 * `tts_*` keys via getSetting/setSetting so the Reviewer can read them
 * directly without prop drilling. The "Test voice" button speaks a short
 * sample so the user can audition before committing.
 */

import { useEffect, useState } from 'react';
import { getSetting, setSetting } from '@/lib/db/queries';
import { isTtsSupported, listVoices, speak, cancelSpeech } from '@/lib/tts/speak';

export default function TtsSettings() {
  const supported = isTtsSupported();

  const [enabled, setEnabled] = useState(false);
  const [autoFront, setAutoFront] = useState(false);
  const [autoBack, setAutoBack] = useState(false);
  const [voiceURI, setVoiceURI] = useState<string>('');
  const [rate, setRate] = useState<number>(1);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    (async () => {
      const [e, af, ab, v, r] = await Promise.all([
        getSetting('tts_enabled'),
        getSetting('tts_autoplay_front'),
        getSetting('tts_autoplay_back'),
        getSetting('tts_voice_uri'),
        getSetting('tts_rate'),
      ]);
      setEnabled(e === '1');
      setAutoFront(af === '1');
      setAutoBack(ab === '1');
      setVoiceURI(v ?? '');
      setRate(r ? parseFloat(r) : 1);
    })();
    if (supported) {
      listVoices().then(setVoices);
    }
  }, [supported]);

  const persist = async (key: string, value: string) => {
    await setSetting(key, value);
  };

  if (!supported) {
    return (
      <p className="text-sm font-light text-dark-300">
        Your browser doesn&apos;t expose the SpeechSynthesis API. Read-aloud is
        only available in Chromium-based browsers, Safari 14+, and recent Firefox.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <ToggleRow
        label="Enable read-aloud"
        help="Master switch. When off, the speaker button hides and auto-play stops."
        checked={enabled}
        onChange={async v => { setEnabled(v); await persist('tts_enabled', v ? '1' : '0'); if (!v) cancelSpeech(); }}
      />

      <ToggleRow
        label="Auto-play front"
        help="Speak the prompt automatically when a card appears."
        checked={autoFront}
        onChange={async v => { setAutoFront(v); await persist('tts_autoplay_front', v ? '1' : '0'); }}
        disabled={!enabled}
      />

      <ToggleRow
        label="Auto-play back"
        help="Speak the answer automatically when you reveal it."
        checked={autoBack}
        onChange={async v => { setAutoBack(v); await persist('tts_autoplay_back', v ? '1' : '0'); }}
        disabled={!enabled}
      />

      <label className="block">
        <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">Voice</div>
        <select
          value={voiceURI}
          onChange={async e => { setVoiceURI(e.target.value); await persist('tts_voice_uri', e.target.value); }}
          disabled={!enabled || voices.length === 0}
          className="w-full bg-dark-800/30 rounded-xl px-3 py-2 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] cursor-pointer disabled:opacity-40"
        >
          <option value="">System default</option>
          {voices.map(v => (
            <option key={v.voiceURI} value={v.voiceURI}>
              {v.name} {v.lang ? `· ${v.lang}` : ''}{v.localService ? '' : ' (network)'}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5 flex items-center justify-between">
          <span>Speed</span>
          <span className="font-mono text-saffron-300 tabular-nums">{rate.toFixed(2)}×</span>
        </div>
        <input
          type="range"
          min={0.5}
          max={2.0}
          step={0.05}
          value={rate}
          onChange={async e => {
            const n = parseFloat(e.target.value);
            setRate(n);
            await persist('tts_rate', String(n));
          }}
          disabled={!enabled}
          className="w-full accent-saffron-400 disabled:opacity-40"
        />
        <div className="text-2xs text-dark-500 mt-1 font-light">
          1.5× is a comfortable pace for prose-dense study material once you&apos;re used to TTS.
        </div>
      </label>

      <button
        onClick={() => speak(
          'This is a sample of the read-aloud voice. Adjust speed and voice above until it sounds natural.',
          { voiceURI: voiceURI || undefined, rate },
        )}
        disabled={!enabled}
        className="btn-gradient px-4 py-2 rounded-lg text-2xs uppercase tracking-[0.2em] font-light disabled:opacity-40"
      >
        ▶ Test voice
      </button>
    </div>
  );
}

function ToggleRow({
  label, help, checked, onChange, disabled,
}: {
  label: string;
  help: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-start gap-3 cursor-pointer ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        disabled={disabled}
        className="mt-1 accent-saffron-400"
      />
      <div>
        <div className="text-2xs uppercase tracking-widest text-dark-400">{label}</div>
        <div className="text-2xs text-dark-500 mt-1 font-light">{help}</div>
      </div>
    </label>
  );
}
