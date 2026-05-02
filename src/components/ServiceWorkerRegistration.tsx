'use client';

import { useEffect, useState } from 'react';
import { BASE_PATH, withBasePath } from '@/lib/basePath';

export default function ServiceWorkerRegistration() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

    const register = async () => {
      try {
        // Register the SW under the deploy basePath so it controls the
        // right scope when behind /cards. Locally (no basePath) this resolves
        // to '/sw.js' with scope '/' — same as before.
        const reg = await navigator.serviceWorker.register(
          withBasePath('/sw.js'),
          { scope: BASE_PATH ? `${BASE_PATH}/` : '/' },
        );
        setRegistration(reg);
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              setUpdateAvailable(true);
            }
          });
        });
        setInterval(() => { reg.update(); }, 60 * 60 * 1000);

        // Request persistent storage so IndexedDB isn't evicted under disk pressure.
        if ('storage' in navigator && 'persist' in navigator.storage) {
          navigator.storage.persist().catch(() => {});
        }
      } catch (err) {
        console.error('[SW] register failed', err);
      }
    };

    register();
  }, []);

  const handleUpdate = () => {
    if (!registration?.waiting) return;
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    window.location.reload();
  };

  if (!updateAvailable) return null;

  return (
    <div className="fixed bottom-4 right-4 max-w-sm glass-card rounded-2xl p-4 z-50 animate-slide-up">
      <h3 className="font-light text-dark-100">Update available</h3>
      <p className="text-sm text-dark-300 mt-1">
        A newer version of Cards is ready. Refresh to apply.
      </p>
      <div className="flex gap-2 mt-3">
        <button onClick={handleUpdate} className="btn-gradient px-4 py-1.5 rounded-lg text-sm">
          Refresh
        </button>
        <button
          onClick={() => setUpdateAvailable(false)}
          className="px-4 py-1.5 text-sm text-dark-300 hover:text-dark-100 transition"
        >
          Later
        </button>
      </div>
    </div>
  );
}
