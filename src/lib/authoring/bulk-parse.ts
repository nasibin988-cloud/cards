/**
 * Parser for the MCAT V5 markdown card-block format. Each block:
 *
 *   > CARD: v5
 *   > Tier: core
 *   > Context: Cell biology
 *   > Front: ...cloze sentence...
 *   > Back: ...
 *   > Extra: ...
 *   > Mnemonic: ...
 *   > Image: filename.svg
 *   > Source: ...
 *   > Tags: tag1 tag2 tag3
 *
 * Blocks are separated by blank lines. Multi-line field values continue with
 * leading "> " on each line. Tag-style and field-name matching is tolerant.
 */

import type { NoteFields, Tier } from '@/lib/db/schema';

export interface BulkParseResult {
  drafts: BulkDraft[];
  errors: Array<{ blockIndex: number; reason: string; raw: string }>;
}

export interface BulkDraft {
  fields: NoteFields;
  tags: string[];
  tier?: Tier;
  modelId: 'basic' | 'cloze';
}

const TIERS = new Set<Tier>([
  'core', 'clinical', 'advanced', 'bridge', 'standard', 'extended', 'scholarly',
]);

interface RawField {
  name: string;
  value: string;
}

export function parseBulk(text: string): BulkParseResult {
  const drafts: BulkDraft[] = [];
  const errors: BulkParseResult['errors'] = [];
  const blocks = splitBlocks(text);

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const fields = parseFields(block);
    if (fields.length === 0) continue;

    // Field "CARD" is a marker; ignore it for content purposes.
    const valueByName = new Map<string, string>();
    for (const f of fields) {
      // Last-write-wins for duplicate keys.
      valueByName.set(f.name.toLowerCase(), f.value);
    }

    const front = valueByName.get('front')?.trim() ?? '';
    if (!front) {
      errors.push({ blockIndex: i, reason: 'No Front field', raw: block });
      continue;
    }
    const back = valueByName.get('back')?.trim() ?? '';
    const extra = valueByName.get('extra')?.trim();
    const mnemonic = valueByName.get('mnemonic')?.trim();
    const context = valueByName.get('context')?.trim();
    const image = valueByName.get('image')?.trim();
    const source = valueByName.get('source')?.trim();

    const rawTags = (valueByName.get('tags') ?? '').trim();
    const tags = rawTags ? rawTags.split(/\s+/).filter(Boolean) : [];

    const tierRaw = (valueByName.get('tier') ?? '').trim().toLowerCase() as Tier;
    const tier = TIERS.has(tierRaw) ? tierRaw : undefined;

    const modelId: 'basic' | 'cloze' = /\{\{c\d+::/.test(front) ? 'cloze' : 'basic';

    drafts.push({
      fields: {
        front, back,
        extra: extra || undefined,
        mnemonic: mnemonic || undefined,
        context: context || undefined,
        image: image || undefined,
        source: source || undefined,
      },
      tags,
      tier,
      modelId,
    });
  }

  return { drafts, errors };
}

function splitBlocks(text: string): string[] {
  // Blocks are separated by one or more blank lines (or non-"> " lines).
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const isQuote = line.startsWith('>') || line.startsWith('> ');
    const isBlank = line.trim() === '';
    if (isQuote) {
      current.push(line);
    } else if (isBlank) {
      if (current.length) { blocks.push(current.join('\n')); current = []; }
    } else {
      // A non-quoted, non-blank line ends the current block.
      if (current.length) { blocks.push(current.join('\n')); current = []; }
    }
  }
  if (current.length) blocks.push(current.join('\n'));
  return blocks;
}

function parseFields(block: string): RawField[] {
  // Strip the "> " prefix and any leading whitespace from each line.
  const lines = block.split('\n').map(l => l.replace(/^>\s*/, ''));
  const fields: RawField[] = [];
  let current: RawField | null = null;

  for (const line of lines) {
    // Allow optional whitespace around the field-name and colon.
    const m = line.match(/^\s*([A-Za-z][A-Za-z\s]*?)\s*:\s?(.*)$/);
    if (m && isLikelyFieldName(m[1])) {
      if (current) fields.push(finalize(current));
      current = { name: m[1].trim(), value: m[2] };
    } else if (current) {
      current.value += (current.value ? '\n' : '') + line;
    }
  }
  if (current) fields.push(finalize(current));
  return fields;
}

const FIELD_NAMES = new Set([
  'CARD', 'Tier', 'Context', 'Front', 'Back', 'Extra', 'Mnemonic', 'Image', 'Source', 'Tags',
]);

function isLikelyFieldName(name: string): boolean {
  return FIELD_NAMES.has(name.trim());
}

function finalize(f: RawField): RawField {
  return { name: f.name, value: f.value.trim() };
}
