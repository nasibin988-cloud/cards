'use client';

import dynamic from 'next/dynamic';

const SourceList = dynamic(() => import('@/components/read/SourceList'), { ssr: false });

export default function ReadPage() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <h1 className="text-4xl font-extralight tracking-tight">Reading</h1>
      <p className="text-dark-400 font-light mt-1 mb-6">
        Drop a passage, paper, or PDF. Highlight the parts worth remembering and turn them into cards in one click.
      </p>
      <SourceList />
    </div>
  );
}
