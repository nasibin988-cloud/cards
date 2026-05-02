'use client';

import dynamic from 'next/dynamic';

const TagManager = dynamic(() => import('@/components/tags/TagManager'), { ssr: false });

export default function TagsPage() {
  return <TagManager />;
}
