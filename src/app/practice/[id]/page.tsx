'use client';

import dynamic from 'next/dynamic';
import { use } from 'react';

const PracticeRunner = dynamic(() => import('@/components/practice/PracticeRunner'), { ssr: false });

export default function PracticeRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <PracticeRunner id={id} />;
}
