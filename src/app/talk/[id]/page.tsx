'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import type { TalkSession } from '@/lib/db/schema';
import { getTalkSession } from '@/lib/db/talk-queries';
import TalkSessionView from '@/components/talk/TalkSession';

export default function TalkSessionPage() {
  const { id } = useParams<{ id: string }>();
  const [session, setSession] = useState<TalkSession | null | undefined>(undefined);

  useEffect(() => {
    if (!id) return;
    getTalkSession(id).then(s => setSession(s ?? null));
  }, [id]);

  if (session === undefined) {
    return (
      <div className="max-w-3xl mx-auto px-4 md:px-6 py-10">
        <div className="glass-card rounded-3xl h-48 loading-shimmer" />
      </div>
    );
  }
  if (session === null) {
    return (
      <div className="max-w-3xl mx-auto px-4 md:px-6 py-10 space-y-4">
        <h1 className="text-2xl font-extralight tracking-tight text-dark-100">Session not found</h1>
        <Link href="/talk" className="text-saffron-300 hover:text-saffron-200 text-sm">← Back to Talk</Link>
      </div>
    );
  }
  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 py-6 md:py-10">
      <TalkSessionView session={session} />
    </div>
  );
}
