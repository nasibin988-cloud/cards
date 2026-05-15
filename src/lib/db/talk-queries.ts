/**
 * Persistence layer for talk sessions. Plain CRUD over the one
 * `talkSessions` table. We do NOT persist audio (recordings are
 * ephemeral); the transcript is the durable artifact.
 */

import { db } from './dexie';
import type { TalkSession, TalkTurn } from './schema';

export async function listTalkSessions(): Promise<TalkSession[]> {
  return db().talkSessions.orderBy('startedAt').reverse().toArray();
}

export async function getTalkSession(id: string): Promise<TalkSession | undefined> {
  return db().talkSessions.get(id);
}

export async function createTalkSession(input: Omit<TalkSession, 'turns' | 'coverage' | 'startedAt'> & {
  turns?: TalkTurn[];
  coverage?: Record<string, number>;
}): Promise<TalkSession> {
  const row: TalkSession = {
    ...input,
    turns: input.turns ?? [],
    coverage: input.coverage ?? {},
    startedAt: Date.now(),
  };
  await db().talkSessions.put(row);
  return row;
}

export async function updateTalkSession(id: string, patch: Partial<TalkSession>): Promise<void> {
  await db().talkSessions.update(id, patch);
}

export async function appendTalkTurn(id: string, turn: TalkTurn): Promise<void> {
  const session = await db().talkSessions.get(id);
  if (!session) return;
  const turns = [...session.turns, turn];
  await db().talkSessions.update(id, { turns });
}

export async function deleteTalkSession(id: string): Promise<void> {
  await db().talkSessions.delete(id);
}
