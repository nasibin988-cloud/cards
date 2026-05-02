'use client';

import dynamic from 'next/dynamic';
import { use } from 'react';

const PathDeckView = dynamic(() => import('@/components/decks/PathDeckView'), { ssr: false });

export default function PathDeckPage({ params }: { params: Promise<{ encoded: string }> }) {
  const { encoded } = use(params);
  const path = decodeURIComponent(encoded);
  return <PathDeckView path={path} />;
}
