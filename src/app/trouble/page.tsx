'use client';

import dynamic from 'next/dynamic';

const TroubleView = dynamic(() => import('@/components/trouble/TroubleView'), { ssr: false });

export default function TroublePage() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <h1 className="text-4xl font-extralight tracking-tight">Trouble cards</h1>
      <p className="text-dark-400 font-light mt-1 mb-6">
        Cards you've lapsed on most often. These usually need rewriting or splitting, not more reps.
      </p>
      <TroubleView />
    </div>
  );
}
