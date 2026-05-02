'use client';

import dynamic from 'next/dynamic';

const SessionsView = dynamic(() => import('@/components/sessions/SessionsView'), { ssr: false });

export default function SessionsPage() {
  return <SessionsView />;
}
