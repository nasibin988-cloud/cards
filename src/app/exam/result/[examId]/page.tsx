'use client';

import { use } from 'react';
import dynamic from 'next/dynamic';

const ExamResult = dynamic(() => import('@/components/exam/ExamResult'), { ssr: false });

export default function ExamResultPage({ params }: { params: Promise<{ examId: string }> }) {
  const { examId } = use(params);
  return <ExamResult examId={examId} />;
}
