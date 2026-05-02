'use client';

import dynamic from 'next/dynamic';

const PracticeList = dynamic(() => import('@/components/practice/PracticeList'), { ssr: false });

export default function PracticePage() {
  return <PracticeList />;
}
