'use client';

import DeckList from '@/components/deck/DeckList';
import TodayBar from '@/components/TodayBar';

export default function Home() {
  return (
    <div className="max-w-5xl mx-auto px-4 md:px-6 py-6 md:py-10">
      <TodayBar />
      <DeckList />
    </div>
  );
}
