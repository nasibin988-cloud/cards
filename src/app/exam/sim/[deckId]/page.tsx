'use client';

import { use } from 'react';
import dynamic from 'next/dynamic';

const SimRunner = dynamic(() => import('@/components/exam/SimRunner'), { ssr: false });

export default function SimPage({ params }: { params: Promise<{ deckId: string }> }) {
  const { deckId } = use(params);
  return <SimRunner deckId={deckId} />;
}
