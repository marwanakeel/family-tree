-- Family Tree — optional Supabase setup for live, shared editing.
-- Run this once in your Supabase project:  Dashboard → SQL Editor → New query → paste → Run.
-- Then put your project URL + anon key into js/config.js.

-- One row holds the whole family tree as JSON (same shape as family.json).
create table if not exists public.family_documents (
  id          text primary key,
  data        jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- Row Level Security on.
alter table public.family_documents enable row level security;

-- Family-friendly policy: anyone holding the public anon key can read & write.
-- This is fine for a private tree on your home network. If you ever expose the
-- site to the public internet, replace these with authenticated-only policies.
drop policy if exists "family read"   on public.family_documents;
drop policy if exists "family insert" on public.family_documents;
drop policy if exists "family update" on public.family_documents;

create policy "family read"   on public.family_documents for select using (true);
create policy "family insert" on public.family_documents for insert with check (true);
create policy "family update" on public.family_documents for update using (true) with check (true);

-- Push live updates to everyone viewing the page.
alter publication supabase_realtime add table public.family_documents;
