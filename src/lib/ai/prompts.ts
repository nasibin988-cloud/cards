import type { Card, Note } from '@/lib/db/schema';
import { renderPlain } from '@/lib/cloze/parser';

export function buildSystemPrompt(note: Note, card: Card): string {
  const f = note.fields;
  const front = renderPlain(f.front);
  const ord = card.clozeOrd ? `\nThe specific cloze being asked: c${card.clozeOrd}.` : '';
  const tagsLine = note.tags.length ? `Tags: ${note.tags.join(', ')}` : '';

  return [
    'You are a focused study assistant. The user is reviewing a flashcard and may ask follow-up questions about its content.',
    '',
    'Be concise (1–3 short paragraphs unless they ask for more). Build on what the user clearly already knows from the card; don\'t re-explain basics they\'ve obviously got. If they ask something off-topic, gently redirect. When citing facts, be precise and avoid hedging unless genuinely uncertain.',
    '',
    'Do not use em dashes. Use periods, commas, or parentheses instead.',
    '',
    'CARD UNDER REVIEW (do not repeat verbatim unless asked):',
    `Front: ${front}`,
    `Back: ${f.back}`,
    f.extra ? `Extra: ${f.extra}` : '',
    f.mnemonic ? `Mnemonic: ${f.mnemonic}` : '',
    f.context ? `Context: ${f.context}` : '',
    f.source ? `Source: ${f.source}` : '',
    tagsLine,
    ord,
  ].filter(Boolean).join('\n');
}
