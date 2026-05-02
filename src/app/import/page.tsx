'use client';

import dynamic from 'next/dynamic';

const ApkgDropzone = dynamic(() => import('@/components/import/ApkgDropzone'), { ssr: false });

export default function ImportPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <h1 className="text-4xl font-extralight tracking-tight">Import</h1>
      <p className="text-dark-400 font-light mt-1 mb-6">
        Drop a <code className="text-saffron-300 font-mono">.apkg</code> file exported from Anki.
        Cloze ords will split into one card each. Media files are stored locally.
      </p>
      <ApkgDropzone />
    </div>
  );
}
