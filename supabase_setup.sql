-- Travel Work Planner V26 - setup Supabase gratuito
-- Esegui tutto nello SQL Editor del tuo progetto Supabase.
create table if not exists public.twp_store (
  id text primary key,
  payload jsonb not null default '{}'::jsonb,
  attachments jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.twp_store enable row level security;

-- Il backend usa la service role key e quindi non richiede policy pubbliche.
-- Non pubblicare mai la service role key nel browser o nel repository.

insert into storage.buckets (id, name, public)
values ('twp-files','twp-files',false)
on conflict (id) do nothing;

create or replace function public.twp_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists twp_store_touch on public.twp_store;
create trigger twp_store_touch before update on public.twp_store
for each row execute function public.twp_touch_updated_at();
