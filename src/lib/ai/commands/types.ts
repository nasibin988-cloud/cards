import type { Card, Note } from '@/lib/db/schema';

export interface CommandContext {
  note: Note;
  card: Card;
}

export interface ImageHit {
  /** Wikimedia file title, including the "File:" prefix. */
  title: string;
  /** Lower-resolution thumbnail URL for the grid. */
  thumbUrl: string;
  /** Full-resolution image URL. */
  fullUrl: string;
  /** Image MIME type, e.g. "image/jpeg". */
  mime: string;
  /** Artist + license string, e.g. "User:Foo, CC BY-SA 4.0". */
  attribution?: string;
  /** Native pixel dimensions when available. */
  width?: number;
  height?: number;
}

export type CommandResult =
  | { kind: 'assistant'; content: string; query?: string }
  | { kind: 'images'; query: string; refinedQuery: string; results: ImageHit[] }
  | { kind: 'clear' }
  | { kind: 'error'; message: string };

export interface SlashCommand {
  /** Without leading slash. */
  name: string;
  /** Human-readable, shown in the menu. */
  description: string;
  /** Optional argument hint shown next to the name. */
  argHint?: string;
  /** Whether this command needs an LLM call (used to gate when offline). */
  needsAI?: boolean;
  /** Implementation. */
  run: (rawArgs: string, ctx: CommandContext) => Promise<CommandResult>;
}
