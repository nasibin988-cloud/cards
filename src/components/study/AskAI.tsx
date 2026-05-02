'use client';

import { useEffect, useRef, useState } from 'react';
import type { Card, Note } from '@/lib/db/schema';
import { getSetting } from '@/lib/db/queries';
import { askClaude, type ChatMessage } from '@/lib/ai/claude';
import { renderRichText } from '@/lib/cloze/parser';
import { cn } from '@/lib/utils';
import { findCommand, parseSlash, suggestCommands, type SlashCommand } from '@/lib/ai/commands/registry';
import type { ImageHit } from '@/lib/ai/commands/types';
import AskSlashMenu from '@/components/study/AskSlashMenu';
import AskImageGrid from '@/components/study/AskImageGrid';

interface Props {
  open: boolean;
  onClose: () => void;
  note: Note;
  card: Card;
}

/**
 * UI-only message stream. The Anthropic API only accepts user/assistant; the
 * `divider` role is a local marker we render between conversation turns when
 * the user navigates to a different card while the panel is open. It is
 * filtered out before being sent.
 */
type UiMessage =
  | { role: 'user' | 'assistant'; content: string }
  | { role: 'divider'; content: string }
  | {
      role: 'images';
      content: '';
      query: string;
      refinedQuery: string;
      results: ImageHit[];
    };

export default function AskAI({ open, onClose, note, card }: Props) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [online, setOnline] = useState(true);
  const lastCardIdRef = useRef<string>(card.id);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Slash-command autocomplete state.
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashActive, setSlashActive] = useState(0);
  const slashSuggestions = slashOpen ? suggestionsFor(input) : [];
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Conversation persists across panel close/open and across card navigation.
  // Only the explicit Clear button resets it.
  //
  // The first time the panel opens (or after Clear), we seed an "on:" divider
  // so the user can see which card the next reply will reference. When the
  // user moves to a different card while the panel is open, we append (or
  // coalesce) another divider for the new card.
  useEffect(() => {
    if (!open) return;

    const sameCard = lastCardIdRef.current === card.id;
    if (sameCard && messages.length > 0) return;

    setMessages(prev => coalesceDivider(prev, previewOf(note)));
    lastCardIdRef.current = card.id;
  }, [open, card.id, note, messages.length]);

  useEffect(() => {
    if (!open) return;
    getSetting('claude_api_key').then(k => setHasKey(!!k));
    setOnline(navigator.onLine);
    const onOff = () => setOnline(false);
    const onOn = () => setOnline(true);
    window.addEventListener('offline', onOff);
    window.addEventListener('online', onOn);
    return () => {
      window.removeEventListener('offline', onOff);
      window.removeEventListener('online', onOn);
    };
  }, [open]);

  // Auto-scroll to bottom on new messages / streaming chunks.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  const send = async () => {
    if (!input.trim() || streaming) return;

    // If the message starts with `/` and matches a registered command, route
    // through that command's handler instead of the chat API.
    const slash = parseSlash(input);
    if (slash) {
      const cmd = findCommand(slash.name);
      if (cmd) {
        await runSlash(cmd, slash.args);
        return;
      }
      // Unknown command — treat as plain text so users learn by trying things.
    }

    const userMsg: UiMessage = { role: 'user', content: input };
    const next: UiMessage[] = [...messages, userMsg];
    setMessages(next);
    setInput('');
    setStreaming(true);
    try {
      let acc = '';
      const assistantIdx = next.length;
      setMessages([...next, { role: 'assistant', content: '' }]);
      const apiHistory: ChatMessage[] = next
        .filter((m): m is UiMessage & { role: 'user' | 'assistant' } =>
          m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.content }));
      await askClaude({
        note,
        card,
        history: apiHistory,
        onDelta: chunk => {
          acc += chunk;
          setMessages(prev => {
            const copy = [...prev];
            copy[assistantIdx] = { role: 'assistant', content: acc };
            return copy;
          });
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessages(prev => [...prev, { role: 'assistant', content: `[error] ${msg}` }]);
    } finally {
      setStreaming(false);
    }
  };

  const runSlash = async (cmd: SlashCommand, args: string) => {
    const userEcho: UiMessage = {
      role: 'user',
      content: args ? `/${cmd.name} ${args}` : `/${cmd.name}`,
    };
    const next: UiMessage[] = [...messages, userEcho];
    setMessages(next);
    setInput('');
    setStreaming(true);
    try {
      const result = await cmd.run(args, { note, card });
      if (result.kind === 'clear') {
        clearConversation();
        return;
      }
      if (result.kind === 'error') {
        setMessages(prev => [...prev, { role: 'assistant', content: `[${cmd.name} error] ${result.message}` }]);
        return;
      }
      if (result.kind === 'images') {
        setMessages(prev => [...prev, {
          role: 'images',
          content: '',
          query: result.query,
          refinedQuery: result.refinedQuery,
          results: result.results,
        }]);
        return;
      }
      // assistant
      setMessages(prev => [...prev, { role: 'assistant', content: result.content }]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessages(prev => [...prev, { role: 'assistant', content: `[${cmd.name} error] ${msg}` }]);
    } finally {
      setStreaming(false);
    }
  };

  const clearConversation = () => {
    setMessages([]);
    setInput('');
    lastCardIdRef.current = card.id;
  };

  const acceptSlash = (cmd: SlashCommand) => {
    // Replace whatever the user has typed with `/cmd ` so they can continue
    // typing the argument. Commands without args run immediately on Enter.
    const next = `/${cmd.name}${cmd.argHint ? ' ' : ''}`;
    setInput(next);
    setSlashOpen(false);
    setSlashActive(0);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  // A non-empty conversation = at least one user/assistant turn beyond the
  // seed divider. Used to gate the Clear button so it doesn't appear when
  // there's nothing to clear.
  const hasConversation = messages.some(m => m.role !== 'divider');

  return (
    <aside
      className={cn(
        'fixed top-0 right-0 h-full w-full md:w-[28rem] z-50 transform transition-transform duration-300',
        'bg-dark-950/95 backdrop-blur-xl border-l border-white/[0.05] flex flex-col',
        open ? 'translate-x-0' : 'translate-x-full',
      )}
    >
      <header className="px-5 py-4 border-b border-white/[0.04] flex items-center justify-between">
        <h2 className="text-sm uppercase tracking-[0.2em] font-light text-dark-100">Ask</h2>
        <div className="flex items-center gap-1 shrink-0">
          {hasConversation && (
            <button
              onClick={clearConversation}
              className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-dark-100 transition px-3 py-1.5 rounded-lg hover:bg-white/[0.04]"
              aria-label="Clear conversation"
            >
              Clear
            </button>
          )}
          <button
            onClick={onClose}
            className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-dark-100 transition px-3 py-1.5 rounded-lg hover:bg-white/[0.04]"
            aria-label="Close panel"
          >
            Close
          </button>
        </div>
      </header>

      {hasKey === false && (
        <div className="px-5 py-4 text-sm text-dark-300 border-b border-white/[0.04] bg-saffron-900/10">
          Add your Claude API key in <a href="/settings" className="text-saffron-300 underline">Settings</a> to use Ask.
        </div>
      )}
      {!online && (
        <div className="px-5 py-3 text-sm text-dark-300 border-b border-white/[0.04] bg-crimson-900/15">
          Offline — Ask requires internet. Study continues without it.
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {messages.map((m, i) => {
          if (m.role === 'divider') {
            return (
              <div
                key={i}
                className="flex items-center gap-3 text-2xs uppercase tracking-widest text-dark-500 py-1"
                role="separator"
              >
                <span className="flex-1 h-px bg-white/[0.05]" />
                <span className="shrink-0 max-w-[18rem] truncate">on: {m.content}</span>
                <span className="flex-1 h-px bg-white/[0.05]" />
              </div>
            );
          }
          if (m.role === 'user') {
            return (
              <div
                key={i}
                className="rounded-xl px-4 py-3 text-sm leading-relaxed font-light whitespace-pre-wrap bg-persian-900/30 text-dark-100 ml-6"
              >
                {m.content}
              </div>
            );
          }
          if (m.role === 'images') {
            return (
              <AskImageGrid
                key={i}
                query={m.query}
                refinedQuery={m.refinedQuery}
                results={m.results}
                note={note}
                card={card}
              />
            );
          }
          const html = m.content
            ? renderRichText(m.content)
            : streaming && i === messages.length - 1 ? '<p>…</p>' : '';
          return (
            <div
              key={i}
              className="rounded-xl px-4 py-3 text-sm leading-relaxed font-light bg-dark-800/40 text-dark-100 card-prose back-prose"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          );
        })}
      </div>

      <footer className="px-5 py-4 border-t border-white/[0.04]">
        <div className="relative">
          {slashOpen && slashSuggestions.length > 0 && (
            <AskSlashMenu
              commands={slashSuggestions}
              activeIdx={Math.min(slashActive, slashSuggestions.length - 1)}
              onPick={(c) => acceptSlash(c)}
            />
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => {
              const v = e.target.value;
              setInput(v);
              setSlashOpen(shouldOpenSlash(v));
              setSlashActive(0);
            }}
            onKeyDown={e => {
              if (e.nativeEvent.isComposing) return;
              if (slashOpen && slashSuggestions.length > 0) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSlashActive(a => Math.min(a + 1, slashSuggestions.length - 1)); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); setSlashActive(a => Math.max(a - 1, 0)); return; }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                  e.preventDefault();
                  acceptSlash(slashSuggestions[Math.min(slashActive, slashSuggestions.length - 1)]);
                  return;
                }
                if (e.key === 'Escape') { e.preventDefault(); setSlashOpen(false); return; }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder={hasKey ? 'Ask, or "/" for commands…' : 'Add API key in Settings first'}
            disabled={!hasKey || streaming || !online}
            className="w-full bg-dark-800/30 rounded-2xl pl-4 pr-11 py-3 text-sm leading-relaxed text-dark-100 placeholder:text-dark-500 resize-none outline-none focus:bg-dark-800/50 transition disabled:opacity-50"
          />
          <button
            onClick={send}
            disabled={!hasKey || streaming || !online || !input.trim()}
            aria-label="Send"
            className={cn(
              'absolute right-2.5 bottom-2.5 w-7 h-7 rounded-full flex items-center justify-center transition',
              !hasKey || streaming || !online || !input.trim()
                ? 'text-dark-700 cursor-not-allowed'
                : 'text-saffron-300 hover:text-saffron-200 hover:bg-saffron-900/20',
            )}
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
              <path
                d="M8 13 L8 3 M3.5 7.5 L8 3 L12.5 7.5"
                stroke="currentColor"
                strokeWidth="1.6"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </footer>
    </aside>
  );
}

/**
 * Open the slash menu only when the user is mid-typing a command — that is,
 * the input starts with `/`, has no whitespace yet (still typing the name),
 * and the resulting command name doesn't already match a complete command
 * with a populated argument.
 */
function shouldOpenSlash(input: string): boolean {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) return false;
  // While the user is typing the command name (no space yet), keep the menu
  // open so partial matches stay visible.
  if (!/\s/.test(trimmed)) return true;
  return false;
}

function suggestionsFor(input: string): SlashCommand[] {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) return [];
  const name = trimmed.slice(1).split(/\s/)[0];
  return suggestCommands(name);
}

/**
 * Append (or coalesce a trailing) "now on:" divider for the given card. If
 * the previous tail is already a divider, replace it instead — that prevents
 * a stack of empty markers when the user moves through cards without asking.
 */
function coalesceDivider(prev: UiMessage[], label: string): UiMessage[] {
  if (prev.length === 0) return [{ role: 'divider', content: label }];
  const last = prev[prev.length - 1];
  if (last.role === 'divider') {
    return [...prev.slice(0, -1), { role: 'divider', content: label }];
  }
  return [...prev, { role: 'divider', content: label }];
}

/**
 * Short, plain-text preview of a note for the divider label. Strips HTML,
 * unwraps the answer from cloze syntax, collapses whitespace, and truncates
 * to roughly one line.
 */
function previewOf(note: Note): string {
  const raw = note.fields.front || note.fields.context || '';
  const unclozed = raw.replace(/\{\{c\d+::([^:}]+)(?:::[^}]*)?\}\}/g, '$1');
  const text = unclozed.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (text.length <= 64) return text;
  return text.slice(0, 60).trimEnd() + '…';
}
