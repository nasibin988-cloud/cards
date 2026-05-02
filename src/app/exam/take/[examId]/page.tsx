'use client';

import { use } from 'react';
import dynamic from 'next/dynamic';

const ExamTaker = dynamic(() => import('@/components/exam/ExamTaker'), { ssr: false });

export default function ExamTakePage({ params }: { params: Promise<{ examId: string }> }) {
  const { examId } = use(params);
  return <ExamTaker examId={examId} />;
}
