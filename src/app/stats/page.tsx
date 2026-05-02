'use client';

import dynamic from 'next/dynamic';

const StatsView = dynamic(() => import('@/components/stats/StatsView'), { ssr: false });

export default function StatsPage() {
  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <h1 className="text-4xl font-extralight tracking-tight mb-6">Stats</h1>
      <StatsView />
    </div>
  );
}
