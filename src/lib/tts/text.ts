/**
 * Card text → TTS-friendly string.
 *
 * The renderer pipeline produces HTML with cloze spans, image tags, and
 * inline LaTeX. None of that should be spoken verbatim. This module turns
 * a card's raw fields into a clean prose string for the SpeechSynthesis
 * engine, with side-aware cloze handling: front clozes become "blank"
 * placeholders, back clozes pronounce the answer.
 */

import type { Note } from '@/lib/db/schema';

const HTML_TAG_RE = /<\/?[a-z][^>]*>/gi;
const SCRIPT_RE = /<script[\s\S]*?<\/script>/gi;
const STYLE_RE = /<style[\s\S]*?<\/style>/gi;
const IMG_RE = /<img\b[^>]*>/gi;
const AUDIO_RE = /<audio\b[\s\S]*?<\/audio>|<audio\b[^/]*\/>/gi;
// Match the same cloze syntax the parser uses: {{c1::answer}} or {{c1::answer::hint}}
const CLOZE_RE = /\{\{c(\d+)::([^}]+?)(?:::[^}]+)?\}\}/g;
const TYPE_CLOZE_RE = /\{\{type::([^}]+?)(?:::[^}]+)?\}\}/g;
// [[query]] / [[query|display]] — read the display text (or the query if no display).
const XLINK_RE = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
// Inline math `$...$` and display math `$$...$$` — strip the dollars; leave
// the body. Most engines handle Greek letters reasonably; raw LaTeX commands
// like \frac are read awkwardly but better than reading dollar signs.
const MATH_INLINE_RE = /\$([^$]+)\$/g;
const MATH_DISPLAY_RE = /\$\$([\s\S]+?)\$\$/g;
// Markdown headings/emphasis we want to drop without pronouncing.
const MD_BOLD_ITAL_RE = /\*+([^*]+)\*+/g;
const MD_HEADING_RE = /^#{1,6}\s+/gm;
const MD_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
// LaTeX command stripper: keep argument text inside braces, drop the command.
const LATEX_COMMAND_RE = /\\[a-zA-Z]+\s*\{([^}]*)\}/g;
const LATEX_BARE_RE = /\\[a-zA-Z]+/g;

export type Side = 'front' | 'back';

/**
 * Turn a single field's raw text into TTS-friendly prose.
 *  - On the FRONT, cloze answers become " blank " markers (so the listener
 *    knows where the gap is).
 *  - On the BACK, cloze answers are pronounced.
 *  - HTML, images, audio, xlink syntax, and LaTeX wrapping are stripped.
 *
 * `clozeOrd` (when supplied) marks the cloze that's the *active* gap on
 * this card. Other clozes on the same field are revealed on both sides.
 */
export function fieldToSpeech(text: string, side: Side, clozeOrd?: number): string {
  if (!text) return '';
  let s = text;

  // Strip dangerous & noisy HTML chunks BEFORE other transforms so the
  // body doesn't pick up tag fragments or script content.
  s = s.replace(SCRIPT_RE, ' ');
  s = s.replace(STYLE_RE, ' ');
  s = s.replace(AUDIO_RE, ' ');
  s = s.replace(IMG_RE, ' ');

  // Clozes — side-aware.
  s = s.replace(CLOZE_RE, (_m, ordStr: string, answer: string) => {
    const matchOrd = parseInt(ordStr, 10);
    if (side === 'front') {
      // Active gap → "blank". Inactive clozes on the same card are revealed
      // (they would be visible in the rendered front, so should be read).
      if (clozeOrd === undefined || matchOrd === clozeOrd) return ' blank ';
      return ` ${answer.trim()} `;
    }
    return ` ${answer.trim()} `;
  });
  s = s.replace(TYPE_CLOZE_RE, (_m, answer: string) => {
    if (side === 'front') return ' blank ';
    return ` ${answer.trim()} `;
  });

  // [[xlink]] — pronounce the display label (the right-hand side of `|`),
  // or the query when there's no label.
  s = s.replace(XLINK_RE, (_m, query: string, display?: string) => {
    return (display ?? query).trim();
  });

  // Math: keep the body, drop the markers + LaTeX commands.
  s = s.replace(MATH_DISPLAY_RE, (_m, body: string) => ` ${body.trim()} `);
  s = s.replace(MATH_INLINE_RE, (_m, body: string) => ` ${body.trim()} `);
  s = s.replace(LATEX_COMMAND_RE, (_m, inside: string) => ` ${inside.trim()} `);
  s = s.replace(LATEX_BARE_RE, ' ');

  // Markdown polish.
  s = s.replace(MD_HEADING_RE, '');
  s = s.replace(MD_BOLD_ITAL_RE, (_m, body: string) => body);
  s = s.replace(MD_LINK_RE, (_m, label: string) => label);

  // Strip remaining HTML tags (we already removed image/audio/script/style).
  s = s.replace(HTML_TAG_RE, ' ');

  // Decode the few HTML entities that survive raw text. Keep small; we're
  // not aiming to be a full entity decoder.
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

  // Collapse whitespace runs.
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Build the TTS string for an entire card side. Concatenates the relevant
 * fields with explicit pauses so the listener can parse the structure.
 *
 *  - front: just the prompt (front field).
 *  - back: prompt + back + extra ("why") + mnemonic. Context is omitted
 *    because it's metadata, not study content.
 */
export function cardToSpeech(
  note: Note,
  side: Side,
  clozeOrd: number | undefined,
): string {
  const front = fieldToSpeech(note.fields.front ?? '', side, clozeOrd);
  if (side === 'front') return front;
  const parts: string[] = [front];
  if (note.fields.back) parts.push(fieldToSpeech(note.fields.back, 'back'));
  if (note.fields.extra) {
    // Stitch with "Why" so the listener knows where the explanation begins.
    parts.push('Why. ' + fieldToSpeech(note.fields.extra, 'back'));
  }
  if (note.fields.mnemonic) {
    parts.push('Mnemonic. ' + fieldToSpeech(note.fields.mnemonic, 'back'));
  }
  return parts.filter(Boolean).join('. ').replace(/\s+/g, ' ').trim();
}
