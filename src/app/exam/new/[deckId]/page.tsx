'use client';

import { use } from 'react';
import dynamic from 'next/dynamic';

const ExamGenerator = dynamic(() => import('@/components/exam/ExamGenerator'), { ssr: false });

export default function ExamNewPage({ params }: { params: Promise<{ deckId: string }> }) {
  const { deckId } = use(params);
  return <ExamGenerator deckId={deckId} />;
}
