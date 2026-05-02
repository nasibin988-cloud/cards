'use client';

import dynamic from 'next/dynamic';
import { use } from 'react';

const Reader = dynamic(() => import('@/components/read/Reader'), { ssr: false });

export default function ReadSourcePage({ params }: { params: Promise<{ sourceId: string }> }) {
  const { sourceId } = use(params);
  return <Reader sourceId={sourceId} />;
}
