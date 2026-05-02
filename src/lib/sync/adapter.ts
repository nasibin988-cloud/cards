/**
 * Pluggable sync adapter. The app produces an encrypted snapshot (opaque
 * ciphertext to the server). Adapters move that ciphertext between client
 * and a backing store.
 *
 * Two adapters ship in V1:
 *   - SupabaseAdapter: writes to a `cards_sync` row keyed by user_id. Schema
 *     SQL is in `docs/cards_sync.sql`; the user runs it once on their project.
 *   - LoopbackAdapter: stores in localStorage; useful for testing the round
 *     trip without a backend.
 *
 * Both expose the same interface so the UI doesn't change between them.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { EncryptedBlob } from './crypto';

export interface RemoteSnapshot {
  blob: EncryptedBlob;
  remoteVersion: number;
  updatedAt: number;
}

export interface SyncAdapter {
  push(blob: EncryptedBlob, version: number): Promise<{ remoteVersion: number }>;
  pull(): Promise<RemoteSnapshot | null>;
}

/* ─── Supabase adapter ───────────────────────────────────────── */

export interface SupabaseConfig {
  url: string;
  anonKey: string;
  email: string;
  password: string;       // sync account password (NOT the encryption pass)
  table?: string;          // defaults to 'cards_sync'
}

export class SupabaseAdapter implements SyncAdapter {
  private client: SupabaseClient;
  private email: string;
  private password: string;
  private table: string;
  private userIdCache: string | null = null;

  constructor(cfg: SupabaseConfig) {
    this.client = createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: false },
    });
    this.email = cfg.email;
    this.password = cfg.password;
    this.table = cfg.table ?? 'cards_sync';
  }

  private async ensureAuth(): Promise<string> {
    if (this.userIdCache) return this.userIdCache;
    // Try sign-in first; if that fails (account doesn't exist), sign up.
    const signin = await this.client.auth.signInWithPassword({
      email: this.email,
      password: this.password,
    });
    let userId: string | null = null;
    if (signin.error || !signin.data.user) {
      const signup = await this.client.auth.signUp({
        email: this.email,
        password: this.password,
      });
      if (signup.error) throw signup.error;
      userId = signup.data.user?.id ?? null;
    } else {
      userId = signin.data.user.id;
    }
    if (!userId) throw new Error('Auth produced no user.');
    this.userIdCache = userId;
    return userId;
  }

  async push(blob: EncryptedBlob, version: number): Promise<{ remoteVersion: number }> {
    const userId = await this.ensureAuth();
    const { error } = await this.client
      .from(this.table)
      .upsert(
        {
          user_id: userId,
          blob,
          version,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      );
    if (error) throw error;
    return { remoteVersion: version };
  }

  async pull(): Promise<RemoteSnapshot | null> {
    const userId = await this.ensureAuth();
    const { data, error } = await this.client
      .from(this.table)
      .select('blob, version, updated_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      blob: data.blob as EncryptedBlob,
      remoteVersion: data.version as number,
      updatedAt: new Date(data.updated_at as string).getTime(),
    };
  }
}

/* ─── Loopback adapter (testing) ─────────────────────────────── */

const LOOPBACK_KEY = 'cards-sync-loopback';

export class LoopbackAdapter implements SyncAdapter {
  async push(blob: EncryptedBlob, version: number): Promise<{ remoteVersion: number }> {
    const stored = {
      blob,
      version,
      updatedAt: Date.now(),
    };
    localStorage.setItem(LOOPBACK_KEY, JSON.stringify(stored));
    return { remoteVersion: version };
  }
  async pull(): Promise<RemoteSnapshot | null> {
    const raw = localStorage.getItem(LOOPBACK_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return {
        blob: parsed.blob,
        remoteVersion: parsed.version,
        updatedAt: parsed.updatedAt,
      };
    } catch {
      return null;
    }
  }
}

/* ─── Setup SQL (commented; user runs once on their Supabase) ── */

export const SUPABASE_SETUP_SQL = `-- Run once in your Supabase SQL editor.
-- Stores one encrypted snapshot per authenticated user.

create extension if not exists "pgcrypto";

create table if not exists public.cards_sync (
  user_id uuid not null primary key references auth.users(id) on delete cascade,
  blob jsonb not null,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.cards_sync enable row level security;

drop policy if exists "Users see only their own snapshot" on public.cards_sync;
create policy "Users see only their own snapshot"
  on public.cards_sync for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
`;
