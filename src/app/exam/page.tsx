'use client';

import dynamic from 'next/dynamic';

const ExamHistory = dynamic(() => import('@/components/exam/ExamHistory'), { ssr: false });

export default function ExamHistoryPage() {
  return <ExamHistory />;
}
