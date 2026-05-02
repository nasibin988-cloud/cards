'use client';

import dynamic from 'next/dynamic';

const AuditView = dynamic(() => import('@/components/audit/AuditView'), { ssr: false });

export default function AuditPage() {
  return <AuditView />;
}
