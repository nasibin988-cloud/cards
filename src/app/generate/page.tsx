'use client';

import dynamic from 'next/dynamic';

const GenerateView = dynamic(() => import('@/components/generate/GenerateView'), { ssr: false });

export default function GeneratePage() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <h1 className="text-4xl font-extralight tracking-tight">Generate cards</h1>
      <p className="text-dark-400 font-light mt-1 mb-6">
        Paste a passage from a textbook, paper, or your own notes. Claude drafts cards in your house style. Review each and accept individually.
      </p>
      <GenerateView />
    </div>
  );
}
