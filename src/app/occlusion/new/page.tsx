'use client';

import dynamic from 'next/dynamic';

const OcclusionAuthor = dynamic(() => import('@/components/occlusion/OcclusionAuthor'), { ssr: false });

export default function NewOcclusionPage() {
  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <h1 className="text-4xl font-extralight tracking-tight">Image occlusion</h1>
      <p className="text-dark-400 font-light mt-1 mb-6">
        Drop an image, draw rectangles by clicking and dragging. Each rectangle becomes one card. Optional label per rectangle for what's revealed on the back.
      </p>
      <OcclusionAuthor />
    </div>
  );
}
