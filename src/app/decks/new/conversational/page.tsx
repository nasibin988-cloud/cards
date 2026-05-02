'use client';

import dynamic from 'next/dynamic';

const ConversationalDeckCreator = dynamic(
  () => import('@/components/decks/ConversationalDeckCreator'),
  { ssr: false },
);

export default function ConversationalDeckPage() {
  return <ConversationalDeckCreator />;
}
