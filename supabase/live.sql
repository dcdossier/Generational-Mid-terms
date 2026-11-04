-- Election-night live results for Racebook.
-- Run once in the Supabase SQL Editor (project racebook-comments). Safe to re-run.
--
-- The site reads these tables with the public anon key (SELECT only) and listens
-- to them over Realtime. Only the Apps Script "Results Desk" writes, using the
-- service key kept in Script Properties. Nothing here grants public writes.

-- ── live_meta: one row describing the night ─────────────────────────────────
create table if not exists public.live_meta (
  id                smallint primary key default 1 check (id = 1),
  polls_first_close timestamptz not null default '2026-11-03T23:00:00Z',
  counting_started  timestamptz,
  last_update       timestamptz,
  status            text not null default 'pre' check (status in ('pre', 'counting', 'final')),
  turnout_pct       numeric(5,2) check (turnout_pct is null or (turnout_pct >= 0 and turnout_pct <= 100)),
  turnout_source    text,
  turnout_updated   timestamptz,
  notes             text
);
insert into public.live_meta (id) values (1) on conflict (id) do nothing;
-- last_push: set by every Results Desk run, even when nothing changed (site watchdog).
alter table public.live_meta add column if not exists last_push timestamptz;
-- Chamber control under the same 3-source rule: {"house": {"party": "D", "called_by": "...", "confirmations": [...]}, "senate": {...}}
alter table public.live_meta add column if not exists control jsonb not null default '{}'::jsonb;

-- ── live_chamber: seats won and leading per chamber and party ───────────────
-- not_up: seats not on the ballot this year. Senate D 34 includes the two
-- independents who caucus with Democrats. Governors: 6 D, 8 R not up.
create table if not exists public.live_chamber (
  chamber    text not null check (chamber in ('house', 'senate', 'gov')),
  party      text not null check (party in ('D', 'R', 'I')),
  won        integer not null default 0 check (won >= 0),
  leading    integer not null default 0 check (leading >= 0),
  not_up     integer not null default 0 check (not_up >= 0),
  updated_at timestamptz not null default now(),
  source     text,
  primary key (chamber, party)
);
insert into public.live_chamber (chamber, party, not_up) values
  ('house',  'D', 0), ('house',  'R', 0), ('house',  'I', 0),
  ('senate', 'D', 34), ('senate', 'R', 31), ('senate', 'I', 0),
  ('gov',    'D', 6),  ('gov',    'R', 8),  ('gov',    'I', 0)
on conflict (chamber, party) do update set not_up = excluded.not_up;
-- Quick-entry pickups typed from AP's list; per-race calls win when present.
alter table public.live_chamber add column if not exists gained integer check (gained is null or gained >= 0);
alter table public.live_chamber add column if not exists lost   integer check (lost   is null or lost   >= 0);

-- ── live_races: featured races and per-race calls ───────────────────────────
-- race_id uses the site's canonical ids: "PA-07", "Senate-NC", "Gov-NV".
-- Featured rows carry vote shares; the House/Senate/Gov calls tabs add a row for
-- every race with just winner, leader and called_by (featured = false).
-- winner is the party a race was called for (needed for flips); leader is
-- whoever is ahead in the count.
create table if not exists public.live_races (
  race_id        text primary key
                 check (race_id ~ '^([A-Z]{2}-([0-9]{2}|AL)|Senate-[A-Z]{2}|Gov-[A-Z]{2})$'),
  featured       boolean not null default false,
  featured_order integer,
  cand_d         text,
  cand_r         text,
  pct_d          numeric(5,2) check (pct_d is null or (pct_d >= 0 and pct_d <= 100)),
  pct_r          numeric(5,2) check (pct_r is null or (pct_r >= 0 and pct_r <= 100)),
  pct_counted    numeric(5,2) check (pct_counted is null or (pct_counted >= 0 and pct_counted <= 100)),
  leader         text check (leader in ('D', 'R', 'I')),
  winner         text check (winner in ('D', 'R', 'I')),
  called_by      text,
  called_at      timestamptz,
  source         text,
  source_url     text check (source_url is null or source_url ~ '^https://'),
  other_sources  jsonb not null default '[]'::jsonb check (jsonb_typeof(other_sources) = 'array'),
  updated_at     timestamptz not null default now()
);
create index if not exists live_races_featured_idx on public.live_races (featured, featured_order);
-- Votes counted so far (state feeds or the desk); the site compares with 2022 totals.
alter table public.live_races add column if not exists total_votes bigint check (total_votes is null or total_votes >= 0);
-- Triangulated calls: the distinct publishers that confirmed the winner [{publisher, url, title, at, desk}].
alter table public.live_races add column if not exists confirmations jsonb not null default '[]'::jsonb check (jsonb_typeof(confirmations) = 'array');

-- ── updated_at on every change ──────────────────────────────────────────────
create or replace function public.live_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists live_chamber_touch on public.live_chamber;
create trigger live_chamber_touch before update on public.live_chamber
  for each row execute function public.live_touch();
drop trigger if exists live_races_touch on public.live_races;
create trigger live_races_touch before update on public.live_races
  for each row execute function public.live_touch();

-- called_at: stamped when a race is first called, cleared if the call is withdrawn.
create or replace function public.live_called_at() returns trigger
language plpgsql as $$
begin
  if new.called_by is null then
    new.called_at := null;
  elsif tg_op = 'INSERT' or old.called_by is null then
    new.called_at := coalesce(new.called_at, now());
  else
    new.called_at := coalesce(new.called_at, old.called_at, now());
  end if;
  return new;
end $$;

drop trigger if exists live_races_called on public.live_races;
create trigger live_races_called before insert or update on public.live_races
  for each row execute function public.live_called_at();

-- ── Row level security: public read, no public writes ───────────────────────
alter table public.live_meta    enable row level security;
alter table public.live_chamber enable row level security;
alter table public.live_races   enable row level security;

drop policy if exists live_meta_read    on public.live_meta;
drop policy if exists live_chamber_read on public.live_chamber;
drop policy if exists live_races_read   on public.live_races;
create policy live_meta_read    on public.live_meta    for select to anon, authenticated using (true);
create policy live_chamber_read on public.live_chamber for select to anon, authenticated using (true);
create policy live_races_read   on public.live_races   for select to anon, authenticated using (true);

revoke insert, update, delete, truncate on public.live_meta, public.live_chamber, public.live_races from anon, authenticated;
grant select on public.live_meta, public.live_chamber, public.live_races to anon, authenticated;

-- ── Realtime ────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['live_meta', 'live_chamber', 'live_races'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- Check: should list all three tables.
-- select tablename from pg_publication_tables where pubname = 'supabase_realtime' and tablename like 'live_%';
