-- ─────────────────────────────────────────────────────────────────────────────
-- Observer comment threads: tables, security and write functions.
--
-- Run this whole file once in Supabase → SQL Editor. It is safe to run again
-- after an edit: tables are created only if missing and functions are replaced.
--
-- After the first run, set the team code (used for reserved names) with:
--     select public.set_admin_code('choose-a-long-code-here');
-- Run it again any time to change the code.
--
-- The site uses only the public anon key. It can read visible comments through
-- the comments_public view and write only through the functions below.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pgcrypto with schema extensions;

-- ── Tables ──────────────────────────────────────────────────────────────────

create table if not exists public.comments (
  id               uuid primary key default gen_random_uuid(),
  page             text not null check (page ~ '^[a-z0-9-]{1,40}$'),
  parent_id        uuid references public.comments(id) on delete cascade,
  name             text not null check (char_length(name) between 1 and 60),
  body             text not null check (char_length(body) between 1 and 4000),
  created_at       timestamptz not null default now(),
  edited_at        timestamptz,
  likes            int not null default 0,
  reports          int not null default 0,
  hidden           boolean not null default false,
  is_team          boolean not null default false,
  edit_token_hash  text,
  ip_hash          text
);
create index if not exists comments_page_idx   on public.comments (page, created_at);
create index if not exists comments_parent_idx on public.comments (parent_id);

create table if not exists public.likes (
  comment_id  uuid not null references public.comments(id) on delete cascade,
  voter_id    text not null,
  created_at  timestamptz not null default now(),
  unique (comment_id, voter_id)
);

create table if not exists public.reports (
  comment_id  uuid not null references public.comments(id) on delete cascade,
  voter_id    text not null,
  ip_hash     text,
  created_at  timestamptz not null default now(),
  unique (comment_id, voter_id)
);

-- One row only: the bcrypt hash of the team code, and the salt for IP hashes.
create table if not exists public.admin_secret (
  id         int primary key default 1 check (id = 1),
  code_hash  text,
  ip_salt    text not null default encode(extensions.gen_random_bytes(32), 'hex')
);
insert into public.admin_secret (id) values (1) on conflict (id) do nothing;

-- Recent actions per hashed IP, for rate limits. Rows older than a day are pruned.
create table if not exists public.rate_events (
  ip_hash  text not null,
  kind     text not null,
  at       timestamptz not null default now()
);
create index if not exists rate_events_idx on public.rate_events (ip_hash, kind, at);

-- Words that block a post. Matched as whole words, ignoring case.
-- Add or remove rows here at any time: insert into public.blocked_words values ('word');
create table if not exists public.blocked_words (word text primary key);
insert into public.blocked_words (word) values
  ('fuck'), ('fucking'), ('fucker'), ('motherfucker'), ('shit'), ('bullshit'), ('cunt'),
  ('bitch'), ('bastard'), ('asshole'), ('dickhead'), ('wanker'), ('twat'), ('whore'), ('slut'),
  ('nigger'), ('nigga'), ('faggot'), ('fag'), ('retard'), ('retarded'), ('kike'), ('spic'),
  ('chink'), ('paki'), ('raghead'), ('towelhead'), ('wetback'), ('tranny'),
  ('madarchod'), ('behenchod'), ('bhenchod'), ('chutiya'), ('bhosdike'), ('randi'),
  ('viagra'), ('cialis'), ('casino'), ('porn')
on conflict (word) do nothing;

-- ── Row level security and grants ───────────────────────────────────────────
-- RLS is on everywhere. The public may read visible comments only, and only the
-- columns granted below (never ip_hash, edit_token_hash, reports or hidden).
-- There are no insert, update or delete policies: every write goes through the
-- security-definer functions further down.

alter table public.comments      enable row level security;
alter table public.likes         enable row level security;
alter table public.reports       enable row level security;
alter table public.admin_secret  enable row level security;
alter table public.rate_events   enable row level security;
alter table public.blocked_words enable row level security;

revoke all on public.comments, public.likes, public.reports, public.admin_secret,
              public.rate_events, public.blocked_words
  from anon, authenticated;

grant select (id, page, parent_id, name, body, created_at, edited_at, likes, is_team)
  on public.comments to anon, authenticated;

drop policy if exists "Visible comments are public" on public.comments;
create policy "Visible comments are public" on public.comments
  for select to anon, authenticated using (hidden = false);

-- The site reads through this view. security_invoker keeps the RLS policy and
-- the column grants above in force for whoever queries it.
create or replace view public.comments_public with (security_invoker = true) as
  select id, page, parent_id, name, body, created_at, edited_at, likes, is_team
  from public.comments;
grant select on public.comments_public to anon, authenticated;

-- ── Internal helpers (not callable by the public) ───────────────────────────

-- sha256 of the visitor's IP plus a private salt. Prefers the address set by
-- Supabase's edge (cf-connecting-ip), then the first x-forwarded-for entry.
create or replace function public._client_ip_hash()
returns text language plpgsql stable security definer
set search_path = public, extensions as $$
declare
  h    json;
  ip   text;
  salt text;
begin
  h := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json;
  ip := coalesce(nullif(h->>'cf-connecting-ip', ''),
                 nullif(trim(split_part(h->>'x-forwarded-for', ',', 1)), ''),
                 nullif(h->>'x-real-ip', ''),
                 'unknown');
  select s.ip_salt into salt from public.admin_secret s where s.id = 1;
  return encode(extensions.digest(ip || coalesce(salt, ''), 'sha256'), 'hex');
end $$;

-- True when this IP has done `lim` or more of `kinds` in the last `win`.
create or replace function public._rate_limited(p_ip text, p_kinds text[], p_lim int, p_win interval)
returns boolean language sql stable security definer
set search_path = public as $$
  select count(*) >= p_lim from public.rate_events
  where ip_hash = p_ip and kind = any (p_kinds) and at > now() - p_win;
$$;

-- Names only the team may use: "Abhishek Kadiyala", "Anil Raman", "Takshashila",
-- "DC Dossier", "Admin", "Moderator", in any case and with any spacing or punctuation.
-- "[deleted]" is reserved too, so nobody can imitate a deleted comment.
create or replace function public._is_reserved_name(p_name text)
returns boolean language sql immutable
set search_path = public as $$
  with n as (select lower(regexp_replace(p_name, '[[:space:][:punct:]]+', '', 'g')) as v)
  select v in ('admin', 'administrator', 'moderator', 'mod', 'deleted')
      or v like '%abhishekkadiyala%' or v like '%anilraman%'
      or v like '%takshashila%' or v like '%dcdossier%'
  from n;
$$;

create or replace function public._has_blocked_word(p_text text)
returns boolean language sql stable security definer
set search_path = public as $$
  select exists (select 1 from public.blocked_words w where p_text ~* ('\m' || w.word || '\M'));
$$;

-- Shared checks for a comment body. Returns an error code, or null when fine.
create or replace function public._body_problem(p_body text)
returns text language plpgsql stable security definer
set search_path = public as $$
begin
  if p_body is null or char_length(p_body) < 1 or char_length(p_body) > 4000 then return 'BODY_LENGTH'; end if;
  if (select count(*) from regexp_matches(p_body, 'https?://', 'gi')) > 3 then return 'TOO_MANY_LINKS'; end if;
  if public._has_blocked_word(p_body) then return 'BLOCKED_WORD'; end if;
  return null;
end $$;

-- ── Public write functions ──────────────────────────────────────────────────
-- Each returns JSON: {"ok": true, ...} or {"error": "CODE"}. Errors are returned,
-- not raised, so that failed attempts can still be recorded for rate limits.

create or replace function public.post_comment(
  p_page text, p_parent_id uuid, p_name text, p_body text,
  p_admin_code text default null, p_honeypot text default null)
returns json language plpgsql security definer
set search_path = public, extensions as $$
declare
  v_name   text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_body   text := trim(both e' \t\r\n' from replace(coalesce(p_body, ''), e'\r\n', e'\n'));
  v_ip     text := public._client_ip_hash();
  v_team   boolean := false;
  v_hash   text;
  v_token  text;
  v_id     uuid;
  v_prob   text;
  v_parent public.comments%rowtype;
begin
  if coalesce(p_honeypot, '') <> '' then return json_build_object('error', 'REJECTED'); end if;
  if p_page is null or p_page !~ '^[a-z0-9-]{1,40}$' then return json_build_object('error', 'BAD_PAGE'); end if;
  if char_length(v_name) < 1 or char_length(v_name) > 60 then return json_build_object('error', 'NAME_LENGTH'); end if;
  v_prob := public._body_problem(v_body);
  if v_prob is not null then return json_build_object('error', v_prob); end if;
  if public._has_blocked_word(v_name) then return json_build_object('error', 'BLOCKED_WORD'); end if;

  -- 5 posts (or wrong team codes) per 10 minutes per IP
  if public._rate_limited(v_ip, array['post', 'bad_code'], 5, interval '10 minutes') then
    return json_build_object('error', 'RATE_LIMIT');
  end if;

  if p_parent_id is not null then
    select * into v_parent from public.comments where id = p_parent_id;
    if not found or v_parent.hidden or v_parent.page <> p_page then
      return json_build_object('error', 'BAD_PARENT');
    end if;
  end if;

  if nullif(trim(coalesce(p_admin_code, '')), '') is not null then
    select code_hash into v_hash from public.admin_secret where id = 1;
    if v_hash is null or extensions.crypt(trim(p_admin_code), v_hash) <> v_hash then
      insert into public.rate_events (ip_hash, kind) values (v_ip, 'bad_code');
      return json_build_object('error', 'BAD_CODE');
    end if;
    v_team := true;
  elsif public._is_reserved_name(v_name) then
    return json_build_object('error', 'RESERVED_NAME');
  end if;

  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.comments (page, parent_id, name, body, is_team, edit_token_hash, ip_hash)
  values (p_page, p_parent_id, v_name, v_body, v_team,
          encode(extensions.digest(v_token, 'sha256'), 'hex'), v_ip)
  returning id into v_id;

  insert into public.rate_events (ip_hash, kind) values (v_ip, 'post');
  delete from public.rate_events where at < now() - interval '1 day';

  return json_build_object('ok', true, 'id', v_id, 'edit_token', v_token, 'is_team', v_team,
                           'name', v_name, 'body', v_body, 'created_at', now());
end $$;

-- One like per voter; calling again removes it.
create or replace function public.like_comment(p_id uuid, p_voter_id text)
returns json language plpgsql security definer
set search_path = public as $$
declare
  v_ip    text := public._client_ip_hash();
  v_likes int;
begin
  if p_voter_id is null or p_voter_id !~ '^[A-Za-z0-9_-]{8,64}$' then return json_build_object('error', 'BAD_VOTER'); end if;
  if not exists (select 1 from public.comments where id = p_id and not hidden) then
    return json_build_object('error', 'NOT_FOUND');
  end if;
  if public._rate_limited(v_ip, array['vote'], 60, interval '10 minutes') then
    return json_build_object('error', 'RATE_LIMIT');
  end if;
  insert into public.rate_events (ip_hash, kind) values (v_ip, 'vote');

  delete from public.likes where comment_id = p_id and voter_id = p_voter_id;
  if found then
    update public.comments set likes = greatest(likes - 1, 0) where id = p_id returning likes into v_likes;
    return json_build_object('ok', true, 'liked', false, 'likes', v_likes);
  end if;
  insert into public.likes (comment_id, voter_id) values (p_id, p_voter_id);
  update public.comments set likes = likes + 1 where id = p_id returning likes into v_likes;
  return json_build_object('ok', true, 'liked', true, 'likes', v_likes);
end $$;

-- One report per voter. Three reports hide the comment.
create or replace function public.report_comment(p_id uuid, p_voter_id text)
returns json language plpgsql security definer
set search_path = public as $$
declare
  v_ip      text := public._client_ip_hash();
  v_reports int;
  v_hidden  boolean;
begin
  if p_voter_id is null or p_voter_id !~ '^[A-Za-z0-9_-]{8,64}$' then return json_build_object('error', 'BAD_VOTER'); end if;
  if not exists (select 1 from public.comments where id = p_id and not hidden) then
    return json_build_object('error', 'NOT_FOUND');
  end if;
  if public._rate_limited(v_ip, array['report'], 20, interval '10 minutes') then
    return json_build_object('error', 'RATE_LIMIT');
  end if;

  insert into public.reports (comment_id, voter_id, ip_hash) values (p_id, p_voter_id, v_ip)
  on conflict (comment_id, voter_id) do nothing;
  if not found then return json_build_object('ok', true, 'already', true); end if;
  insert into public.rate_events (ip_hash, kind) values (v_ip, 'report');

  update public.comments set reports = reports + 1, hidden = (reports + 1 >= 3)
  where id = p_id returning reports, hidden into v_reports, v_hidden;
  return json_build_object('ok', true, 'hidden', v_hidden);
end $$;

-- The author may edit within 15 minutes of posting, using the token from post_comment.
create or replace function public.edit_comment(p_id uuid, p_edit_token text, p_body text)
returns json language plpgsql security definer
set search_path = public, extensions as $$
declare
  v_c    public.comments%rowtype;
  v_body text := trim(both e' \t\r\n' from replace(coalesce(p_body, ''), e'\r\n', e'\n'));
  v_prob text;
begin
  select * into v_c from public.comments where id = p_id;
  if not found or v_c.hidden then return json_build_object('error', 'NOT_FOUND'); end if;
  if v_c.edit_token_hash is null or p_edit_token is null
     or encode(extensions.digest(p_edit_token, 'sha256'), 'hex') <> v_c.edit_token_hash then
    return json_build_object('error', 'NOT_AUTHOR');
  end if;
  if v_c.created_at < now() - interval '15 minutes' then return json_build_object('error', 'TOO_LATE'); end if;
  v_prob := public._body_problem(v_body);
  if v_prob is not null then return json_build_object('error', v_prob); end if;
  update public.comments set body = v_body, edited_at = now() where id = p_id;
  return json_build_object('ok', true, 'body', v_body, 'edited_at', now());
end $$;

-- The author may delete within 15 minutes. With replies, it becomes "[deleted]".
create or replace function public.delete_comment(p_id uuid, p_edit_token text)
returns json language plpgsql security definer
set search_path = public, extensions as $$
declare
  v_c public.comments%rowtype;
begin
  select * into v_c from public.comments where id = p_id;
  if not found or v_c.hidden then return json_build_object('error', 'NOT_FOUND'); end if;
  if v_c.edit_token_hash is null or p_edit_token is null
     or encode(extensions.digest(p_edit_token, 'sha256'), 'hex') <> v_c.edit_token_hash then
    return json_build_object('error', 'NOT_AUTHOR');
  end if;
  if v_c.created_at < now() - interval '15 minutes' then return json_build_object('error', 'TOO_LATE'); end if;
  if exists (select 1 from public.comments where parent_id = p_id) then
    update public.comments
    set name = '[deleted]', body = '[deleted]', is_team = false, edit_token_hash = null, edited_at = now()
    where id = p_id;
    return json_build_object('ok', true, 'mode', 'soft');
  end if;
  delete from public.comments where id = p_id;
  return json_build_object('ok', true, 'mode', 'hard');
end $$;

-- Stores the bcrypt hash of the team code. SQL Editor only.
create or replace function public.set_admin_code(p_code text)
returns text language plpgsql security definer
set search_path = public, extensions as $$
begin
  if p_code is null or char_length(trim(p_code)) < 8 then
    raise exception 'Use a code of at least 8 characters.';
  end if;
  update public.admin_secret set code_hash = extensions.crypt(trim(p_code), extensions.gen_salt('bf', 10)) where id = 1;
  return 'Team code saved.';
end $$;

-- ── Who may call what ───────────────────────────────────────────────────────

revoke execute on function
  public._client_ip_hash(), public._rate_limited(text, text[], int, interval),
  public._is_reserved_name(text), public._has_blocked_word(text), public._body_problem(text),
  public.set_admin_code(text)
  from public, anon, authenticated;

revoke execute on function
  public.post_comment(text, uuid, text, text, text, text), public.like_comment(uuid, text),
  public.report_comment(uuid, text), public.edit_comment(uuid, text, text), public.delete_comment(uuid, text)
  from public;
grant execute on function
  public.post_comment(text, uuid, text, text, text, text), public.like_comment(uuid, text),
  public.report_comment(uuid, text), public.edit_comment(uuid, text, text), public.delete_comment(uuid, text)
  to anon, authenticated;

-- ── Realtime: new comments only ─────────────────────────────────────────────
-- The site subscribes to INSERT events only. Realtime applies the RLS policy and
-- column grants above, so hidden comments and private columns are not sent.

do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'comments') then
    alter publication supabase_realtime add table public.comments;
  end if;
end $$;

-- Reload the API so the new tables and functions are available at once.
notify pgrst, 'reload schema';
