# Cloud sync setup

Cards V1 supports end-to-end encrypted cloud sync. Your Supabase server only ever sees ciphertext; the encryption passphrase never leaves your device.

## One-time setup on your Supabase project

1. In the Supabase dashboard, open SQL Editor.
2. Run the contents of `lib/sync/adapter.ts:SUPABASE_SETUP_SQL` (also reproduced below). This creates one table (`cards_sync`) with row-level security so each user only sees their own snapshot.

```sql
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
```

3. (Optional) In **Authentication → Settings**, enable email/password if it isn't already. The sync flow auto-signs-up on first push.

## In the app

1. Settings → **Sync (cloud)** → enter:
   - Supabase URL (e.g. `https://xxxxx.supabase.co`)
   - Supabase anon (public) key
   - Sync account email + password (only used to authenticate against Supabase; not your data)
   - **Encryption passphrase** — this is the one secret that protects your data. The server never sees it. Use a long phrase.
2. Click **Push** to upload an encrypted snapshot.
3. On any other device, repeat the setup with the same email/password and same passphrase, then click **Pull**.

## Important

- **Lose the passphrase, lose the data.** There's no backdoor.
- **The Supabase email/password ≠ encryption passphrase.** The first authenticates with the database; the second decrypts the data. Use different values.
- Multi-device "merge" is not supported in V1: pushes overwrite, pulls overwrite. Use the diverged-state UI in Settings to choose explicitly.
