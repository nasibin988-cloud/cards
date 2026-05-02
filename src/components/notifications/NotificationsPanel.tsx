'use client';

import { useEffect, useState } from 'react';
import {
  buildSummary,
  isEnabled,
  permissionStatus,
  requestPermission,
  setEnabled,
} from '@/lib/notifications/daily';

export default function NotificationsPanel() {
  const [enabled, setEnabledState] = useState<boolean>(false);
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>('default');
  const [preview, setPreview] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setEnabledState(await isEnabled());
    setPerm(permissionStatus());
    try {
      setPreview((await buildSummary()).body);
    } catch {
      // ignore preview errors
    }
  };

  useEffect(() => { refresh(); }, []);

  const grant = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await requestPermission();
      setPerm(result);
      if (result === 'granted') {
        await setEnabled(true);
        setEnabledState(true);
      } else if (result === 'denied') {
        setError('Permission denied. Re-enable in your browser site settings.');
      }
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    const next = !enabled;
    await setEnabled(next);
    setEnabledState(next);
  };

  if (perm === 'unsupported') {
    return (
      <div className="text-sm text-dark-400 font-light">
        Notifications aren't supported in this browser.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="text-xs text-dark-400 font-light leading-relaxed">
        On app open after a 12-hour gap, fire an OS notification with the daily summary
        ({preview ? `e.g. "${preview}"` : 'cards due, retention, maturity'}).
        Browser-native, no server, no API key.
      </div>

      {perm !== 'granted' ? (
        <button
          onClick={grant}
          disabled={busy || perm === 'denied'}
          className="btn-gradient px-4 py-2 rounded-xl text-sm uppercase tracking-[0.2em] font-light disabled:opacity-50"
        >
          {perm === 'denied' ? 'Permission denied' : busy ? 'Asking…' : 'Enable notifications'}
        </button>
      ) : (
        <label className="inline-flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={toggle}
            className="accent-saffron-400"
          />
          <span className="text-sm text-dark-100 font-light">
            Daily summary notifications {enabled ? 'on' : 'off'}
          </span>
        </label>
      )}

      {error && <div className="text-2xs text-crimson-300 font-light">{error}</div>}
    </div>
  );
}
