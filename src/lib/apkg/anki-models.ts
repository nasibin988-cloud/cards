/**
 * Heuristic mapping from Anki note types to our 7-field schema.
 *
 * Anki note models vary widely (Basic, Cloze, Anking-style with 30+ fields, etc.).
 * We extract field-name semantics with case-insensitive heuristics, falling
 * through to `extra` for anything unmapped.
 */

import type { NoteFields } from '@/lib/db/schema';

export interface AnkiModelField {
  name: string;
  ord: number;
}

export interface AnkiModel {
  id: string;
  name: string;
  type: number;          // 0 = standard, 1 = cloze
  flds: AnkiModelField[];
}

interface FieldMatch {
  pattern: RegExp;
  target: keyof NoteFields;
}

// Order matters: more specific patterns come first.
// "Back Extra" must hit `extra` (Anki cloze convention: shown after cloze answer
// on the back side) rather than `back`, because for cloze notes our renderer
// derives front/back from the cloze field and the `back` slot is unused.
const RULES: FieldMatch[] = [
  { pattern: /^(text|front|question|prompt)$/i, target: 'front' },
  { pattern: /^(back\s*extra|extra\s*back|extra|notes?|first\s*aid|additional)$/i, target: 'extra' },
  { pattern: /^(back|answer)$/i, target: 'back' },
  { pattern: /^(mnemonic|memory)$/i, target: 'mnemonic' },
  { pattern: /^(context|background|topic)$/i, target: 'context' },
  { pattern: /^(source|reference|citation|sourc)$/i, target: 'source' },
  { pattern: /^(image|picture|figure|img)$/i, target: 'image' },
];

/**
 * Map Anki field values (in order, matching `model.flds`) to our NoteFields.
 * Unmapped fields are concatenated into `extra` (only if they have content).
 */
export function mapFields(model: AnkiModel, values: string[]): NoteFields {
  const out: NoteFields = { front: '', back: '' };
  const used = new Set<keyof NoteFields>();
  const overflow: string[] = [];
  const sortedFlds = [...model.flds].sort((a, b) => a.ord - b.ord);

  for (let i = 0; i < sortedFlds.length; i++) {
    const fld = sortedFlds[i];
    const value = values[fld.ord] ?? values[i] ?? '';
    if (!value) continue;

    const rule = RULES.find(r => r.pattern.test(fld.name));
    if (rule && !used.has(rule.target)) {
      // For 'image', only assign if it looks like a bare filename.
      if (rule.target === 'image') {
        const m = value.match(/<img[^>]+src=["']([^"']+)["']/i);
        if (m) out.image = m[1];
        else if (/^[\w\-. ]+\.(?:png|jpg|jpeg|gif|svg|webp|bmp)$/i.test(value.trim())) {
          out.image = value.trim();
        }
        else if (value.trim()) overflow.push(`${fld.name}: ${value}`);
      } else {
        out[rule.target] = value;
        used.add(rule.target);
      }
    } else {
      overflow.push(`${fld.name}: ${value}`);
    }
  }

  // Cloze model: when first field has cloze syntax, that's the front regardless of name.
  if (model.type === 1 && !out.front && values[0]) {
    out.front = values[0];
  }
  // Standard fallback: first field → front, second → back if names didn't match.
  if (!out.front && values[0]) out.front = values[0];
  if (!out.back && values[1] && values[1] !== values[0]) out.back = values[1];

  if (overflow.length) {
    out.extra = (out.extra ? out.extra + '\n\n' : '') + overflow.join('\n');
  }
  return out;
}
