/**
 * Build a parent-child tree from a flat deck list.
 *
 * Hierarchy is derived two ways, in priority order:
 *   1. Explicit `parentId` (set programmatically).
 *   2. Anki "::" name convention: "MCAT::Bio::Ch01" produces three nested decks
 *      with names "MCAT", "Bio", "Ch01" and the deepest deck being the leaf.
 *
 * For (2), we infer the parent at render time WITHOUT mutating the data, so
 * the original deck names stay intact and we don't have to rewrite imports.
 */

import type { Deck } from '@/lib/db/schema';

export interface DeckNode {
  deck: Deck | null;       // null for synthesized parent stubs
  displayName: string;
  fullPath: string;
  children: DeckNode[];
}

export function buildDeckTree(decks: Deck[]): DeckNode[] {
  // Group by Anki "::" hierarchical name (most common in imports).
  const root: DeckNode = { deck: null, displayName: '', fullPath: '', children: [] };

  for (const d of decks) {
    const segments = d.name.split('::').map(s => s.trim()).filter(Boolean);
    let cursor = root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const fullPath = segments.slice(0, i + 1).join('::');
      let child = cursor.children.find(c => c.displayName === seg);
      if (!child) {
        child = { deck: null, displayName: seg, fullPath, children: [] };
        cursor.children.push(child);
      }
      // Attach the actual deck only at the final segment.
      if (i === segments.length - 1) child.deck = d;
      cursor = child;
    }
  }

  // Sort each level alphabetically.
  const sortRec = (node: DeckNode) => {
    node.children.sort((a, b) => a.displayName.localeCompare(b.displayName));
    for (const c of node.children) sortRec(c);
  };
  sortRec(root);

  return root.children;
}
