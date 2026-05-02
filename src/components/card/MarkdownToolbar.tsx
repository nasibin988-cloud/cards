'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { Tooltip } from '@/components/ui/Tooltip';

/**
 * Compact toolbar that wraps a textarea ref. Each button mutates the value
 * in place around the current selection: bold/italic/code wrap; headings
 * and lists prefix the line; link wraps `[text](url)` placeholders.
 */
export interface MarkdownToolbarProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (next: string) => void;
}

type Action =
  | { kind: 'wrap'; before: string; after: string; placeholder: string; label: string; title: string }
  | { kind: 'linePrefix'; prefix: string; label: string; title: string }
  | { kind: 'link'; label: string; title: string };

const ACTIONS: Action[] = [
  { kind: 'wrap', before: '**', after: '**', placeholder: 'bold', label: 'B', title: 'Bold (Cmd+B)' },
  { kind: 'wrap', before: '*', after: '*', placeholder: 'italic', label: 'I', title: 'Italic (Cmd+I)' },
  { kind: 'wrap', before: '`', after: '`', placeholder: 'code', label: '<>', title: 'Inline code' },
  { kind: 'linePrefix', prefix: '# ', label: 'H1', title: 'Heading 1' },
  { kind: 'linePrefix', prefix: '## ', label: 'H2', title: 'Heading 2' },
  { kind: 'linePrefix', prefix: '### ', label: 'H3', title: 'Heading 3' },
  { kind: 'linePrefix', prefix: '- ', label: '•', title: 'Bulleted list' },
  { kind: 'linePrefix', prefix: '1. ', label: '1.', title: 'Numbered list' },
  { kind: 'linePrefix', prefix: '> ', label: '"', title: 'Blockquote' },
  { kind: 'link', label: '↗', title: 'Link' },
];

export default function MarkdownToolbar({ textareaRef, onChange }: MarkdownToolbarProps) {
  const lastFocus = useRef<{ start: number; end: number } | null>(null);

  const apply = (action: Action) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    const value = ta.value;
    const selected = value.slice(start, end);

    let next = value;
    let nextStart = start;
    let nextEnd = end;

    if (action.kind === 'wrap') {
      const inner = selected || action.placeholder;
      next = value.slice(0, start) + action.before + inner + action.after + value.slice(end);
      nextStart = start + action.before.length;
      nextEnd = nextStart + inner.length;
    } else if (action.kind === 'linePrefix') {
      // Find the start of the current line.
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const lineEnd = value.indexOf('\n', end);
      const segEnd = lineEnd === -1 ? value.length : lineEnd;
      const segment = value.slice(lineStart, segEnd);
      // Prefix every line in the selected segment.
      const prefixed = segment
        .split('\n')
        .map(l => action.prefix + l)
        .join('\n');
      next = value.slice(0, lineStart) + prefixed + value.slice(segEnd);
      nextStart = lineStart + action.prefix.length;
      nextEnd = nextStart + prefixed.length - action.prefix.length;
    } else {
      // link: wrap or insert `[text](url)`.
      const text = selected || 'text';
      const url = 'https://';
      const inserted = `[${text}](${url})`;
      next = value.slice(0, start) + inserted + value.slice(end);
      // Place cursor inside the URL placeholder so the user can paste.
      nextStart = start + 1 + text.length + 2; // after `](`
      nextEnd = nextStart + url.length;
    }

    onChange(next);
    // Restore selection on the next tick so the controlled-component update
    // has flushed. Some browsers reset selection on value swap.
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(nextStart, nextEnd);
    });
  };

  // Attach blur handler in a proper effect; mutating DOM during render breaks
  // controlled-component updates from synthetic events Playwright dispatches.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const onBlur = () => {
      lastFocus.current = { start: ta.selectionStart ?? 0, end: ta.selectionEnd ?? 0 };
    };
    ta.addEventListener('blur', onBlur);
    return () => ta.removeEventListener('blur', onBlur);
  }, [textareaRef]);

  return (
    <div className="flex items-center gap-0.5 mb-1.5 -mt-0.5">
      {ACTIONS.map(a => (
        <Tooltip key={a.label + (a.kind === 'wrap' ? a.before : a.kind === 'linePrefix' ? a.prefix : 'link')} content={a.title}>
          <button
            type="button"
            onMouseDown={e => e.preventDefault()} // keep focus on the textarea
            onClick={() => apply(a)}
            aria-label={a.title}
            className="text-2xs font-mono px-1.5 py-0.5 rounded text-dark-500 hover:text-dark-100 hover:bg-white/[0.04] transition"
          >
            {a.label}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}
