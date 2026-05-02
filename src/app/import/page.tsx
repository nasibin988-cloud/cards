'use client';

import dynamic from 'next/dynamic';

const ApkgDropzone = dynamic(() => import('@/components/import/ApkgDropzone'), { ssr: false });
const ResyncOrderDropzone = dynamic(
  () => import('@/components/import/ResyncOrderDropzone'),
  { ssr: false },
);

export default function ImportPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-10 space-y-12">
      <section>
        <h1 className="text-4xl font-extralight tracking-tight">Import</h1>
        <p className="text-dark-400 font-light mt-1 mb-6">
          Drop a <code className="text-saffron-300 font-mono">.apkg</code> file exported from Anki.
          Cloze ords will split into one card each. Media files are stored locally.
        </p>
        <ApkgDropzone />
      </section>

      <section>
        <h2 className="text-2xl font-extralight tracking-tight">Resync card order</h2>
        <p className="text-dark-400 font-light mt-1 mb-6">
          Early imports stamped every note with the same{' '}
          <code className="text-persian-300 font-mono">createdAt</code>, so the
          new-card queue came back in essentially random order. Drop the same{' '}
          <code className="text-persian-300 font-mono">.apkg</code> here to rewrite{' '}
          <code className="text-persian-300 font-mono">createdAt</code> in Anki's
          authoring order. Schedule, due dates, lapses, and reps are untouched.
        </p>
        <ResyncOrderDropzone />
      </section>
    </div>
  );
}
