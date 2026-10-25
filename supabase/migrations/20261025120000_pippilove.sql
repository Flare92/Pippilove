-- ═══════════════════════════════════════════════════════════════
--  PippiLove — database (Supabase)
--  Si può rieseguire senza danni.
--
--  Privacy:
--  · colloqui, appunti di Selene e check-in sono visibili SOLO a chi li scrive;
--  · l'altra persona non li legge mai: Selene li usa per creare missioni e consigli;
--  · le missioni restano una sorpresa per chi le riceve finché non sono fatte;
--  · le proposte personali restano segrete finché non diventano una missione.
-- ═══════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ── Tabelle ────────────────────────────────────────────────────
create table if not exists public.couples (
  id uuid primary key default gen_random_uuid(),
  invite_code text unique not null default upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 6)),
  safe_word text,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  couple_id uuid references public.couples on delete set null,
  display_name text not null default '',
  created_at timestamptz not null default now()
);

-- Il colloquio con Selene (solo l'autore lo vede)
create table if not exists public.interview_messages (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists interview_user_idx on public.interview_messages (user_id, id desc);

-- Gli appunti che Selene (Claude) ricava dai colloqui: la "memoria" dell'app
create table if not exists public.insights (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  topic text not null,
  note text not null,
  shareable boolean not null default true,   -- false = Selene non lo usa per le missioni
  source text not null default 'interview',
  created_at timestamptz not null default now()
);
create index if not exists insights_user_idx on public.insights (user_id, id);

-- Come stai oggi
create table if not exists public.checkins (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  day date not null,
  mood smallint check (mood between 1 and 5),
  energy smallint check (energy between 1 and 5),
  stress smallint check (stress between 1 and 5),
  desire smallint check (desire between 1 and 5),
  time_tonight text,
  note text check (char_length(note) <= 2000),
  wish text check (char_length(wish) <= 1000),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- Il consiglio di Selene per oggi
create table if not exists public.daily_tips (
  user_id uuid not null references auth.users on delete cascade,
  day date not null,
  content jsonb not null,
  basis text,
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- Cose che una persona sa già di volere
create table if not exists public.proposals (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples on delete cascade,
  author_id uuid not null default auth.uid() references auth.users on delete cascade,
  kind text not null check (kind in ('receive', 'give', 'together')),
  body text not null check (char_length(body) between 3 and 500),
  intensity smallint not null default 1 check (intensity between 1 and 3),
  created_at timestamptz not null default now()
);
create index if not exists proposals_couple_idx on public.proposals (couple_id);

-- Le missioni settimanali scritte da Selene
create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples on delete cascade,
  week_start date not null,
  giver_id uuid not null references auth.users on delete cascade,
  receiver_id uuid not null references auth.users on delete cascade,
  ai_title text,
  ai_text text,
  ai_why text,
  ai_category text,
  ai_intensity smallint,
  proposal_id uuid references public.proposals on delete set null,
  proposal_body text,
  proposal_author uuid,
  status text not null default 'pending' check (status in ('pending', 'done')),
  rerolls smallint not null default 0,
  reroll_reasons text[] not null default '{}',
  rating smallint check (rating between 1 and 5),
  feedback text,
  done_at timestamptz,
  created_at timestamptz not null default now(),
  unique (couple_id, week_start, giver_id)
);
create index if not exists challenges_couple_idx on public.challenges (couple_id, week_start desc);

-- ── Helper ─────────────────────────────────────────────────────
create or replace function public.my_couple() returns uuid
language sql stable security definer set search_path = public as $$
  select couple_id from profiles where id = auth.uid()
$$;

create or replace function public.my_partner() returns uuid
language sql stable security definer set search_path = public as $$
  select p.id from profiles p
  where p.couple_id = (select couple_id from profiles where id = auth.uid())
    and p.id <> auth.uid()
  limit 1
$$;

create or replace function public.current_week() returns date
language sql stable as $$
  select date_trunc('week', (now() at time zone 'Europe/Rome'))::date
$$;

create or replace function public.rome_today() returns date
language sql stable as $$
  select (now() at time zone 'Europe/Rome')::date
$$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', ''))
  on conflict (id) do nothing;
  return new;
end $$;

-- profili per chi si è registrato prima che esistesse il database
insert into public.profiles (id, display_name)
select id, coalesce(raw_user_meta_data ->> 'name', '') from auth.users
on conflict (id) do nothing;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Row Level Security ─────────────────────────────────────────
alter table public.couples enable row level security;
alter table public.profiles enable row level security;
alter table public.interview_messages enable row level security;
alter table public.insights enable row level security;
alter table public.checkins enable row level security;
alter table public.daily_tips enable row level security;
alter table public.proposals enable row level security;
alter table public.challenges enable row level security;   -- nessuna policy: solo via funzioni

drop policy if exists couples_select on public.couples;
create policy couples_select on public.couples for select using (id = public.my_couple());
drop policy if exists couples_update on public.couples;
create policy couples_update on public.couples for update using (id = public.my_couple());

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or (couple_id is not null and couple_id = public.my_couple()));
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

-- colloquio: si legge (e si può cancellare) solo il proprio; scrive la funzione Selene
drop policy if exists interview_read on public.interview_messages;
create policy interview_read on public.interview_messages for select using (user_id = auth.uid());
drop policy if exists interview_delete on public.interview_messages;
create policy interview_delete on public.interview_messages for delete using (user_id = auth.uid());

-- appunti di Selene: si leggono e si possono cancellare o rendere privati
drop policy if exists insights_read on public.insights;
create policy insights_read on public.insights for select using (user_id = auth.uid());
drop policy if exists insights_delete on public.insights;
create policy insights_delete on public.insights for delete using (user_id = auth.uid());
drop policy if exists insights_update on public.insights;
create policy insights_update on public.insights for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists checkins_own on public.checkins;
create policy checkins_own on public.checkins for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists tips_read on public.daily_tips;
create policy tips_read on public.daily_tips for select using (user_id = auth.uid());

drop policy if exists proposals_own on public.proposals;
create policy proposals_own on public.proposals for all
  using (author_id = auth.uid())
  with check (author_id = auth.uid() and couple_id = public.my_couple());

-- colonne modificabili dal telefono (il resto passa dalle funzioni)
revoke update on public.profiles from anon, authenticated;
grant update (display_name) on public.profiles to authenticated;
revoke update on public.insights from anon, authenticated;
grant update (shareable) on public.insights to authenticated;
revoke update on public.couples from anon, authenticated;
grant update (safe_word) on public.couples to authenticated;

-- ── Coppia ─────────────────────────────────────────────────────
create or replace function public.create_couple() returns text
language plpgsql security definer set search_path = public as $$
declare v_couple couples;
begin
  if auth.uid() is null then raise exception 'Non autenticato'; end if;
  if (select couple_id from profiles where id = auth.uid()) is not null then
    return (select invite_code from couples where id = (select couple_id from profiles where id = auth.uid()));
  end if;
  insert into couples default values returning * into v_couple;
  update profiles set couple_id = v_couple.id where id = auth.uid();
  return v_couple.invite_code;
end $$;

create or replace function public.join_couple(p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_count int;
begin
  if auth.uid() is null then raise exception 'Non autenticato'; end if;
  select id into v_id from couples where invite_code = upper(trim(p_code));
  if v_id is null then raise exception 'Codice non valido'; end if;
  select count(*) into v_count from profiles where couple_id = v_id and id <> auth.uid();
  if v_count >= 2 then raise exception 'Questa coppia è già completa'; end if;
  update profiles set couple_id = v_id where id = auth.uid();
  return v_id;
end $$;

-- Stato del partner, senza rivelare nulla di privato
create or replace function public.partner_status() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'partner_id', p.id,
    'name', p.display_name,
    'insights', (select count(*) from insights i where i.user_id = p.id),
    'interview_turns', (select count(*) from interview_messages m where m.user_id = p.id and m.role = 'user'),
    'checked_in_today', exists (select 1 from checkins c where c.user_id = p.id and c.day = public.rome_today()),
    'secret_proposals', (
      select count(*) from proposals pr
      where pr.author_id = p.id
        and not exists (select 1 from challenges ch where ch.proposal_id = pr.id and ch.status = 'done')
    )
  )
  from profiles p
  where p.id = public.my_partner()
$$;

-- ── Missioni ───────────────────────────────────────────────────
-- Chi riceve vede il contenuto solo dopo che è stata fatta
create or replace function public.get_challenges() returns table (
  id uuid, week_start date, giver_id uuid, receiver_id uuid, status text, rerolls smallint,
  title text, body text, why text, category text, intensity smallint,
  proposal_body text, proposal_by_me boolean, hidden boolean,
  rating smallint, feedback text, done_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select ch.id, ch.week_start, ch.giver_id, ch.receiver_id, ch.status, ch.rerolls,
         case when h.hidden then null else ch.ai_title end,
         case when h.hidden then null else ch.ai_text end,
         case when h.hidden or ch.giver_id <> auth.uid() then null else ch.ai_why end,
         case when h.hidden then null else ch.ai_category end,
         case when h.hidden then null else ch.ai_intensity end,
         case when h.hidden then null else ch.proposal_body end,
         ch.proposal_author = auth.uid(),
         h.hidden, ch.rating, ch.feedback, ch.done_at
    from challenges ch
    cross join lateral (select (ch.receiver_id = auth.uid() and ch.status = 'pending') as hidden) h
   where ch.couple_id = public.my_couple()
   order by ch.week_start desc, ch.giver_id = auth.uid() desc
$$;

create or replace function public.complete_challenge(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update challenges set status = 'done', done_at = now()
   where id = p_id and giver_id = auth.uid() and status = 'pending';
  if not found then raise exception 'Missione non trovata'; end if;
end $$;

create or replace function public.rate_challenge(p_id uuid, p_rating int, p_feedback text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  update challenges set rating = p_rating, feedback = nullif(trim(p_feedback), '')
   where id = p_id and receiver_id = auth.uid() and status = 'done';
  if not found then raise exception 'Missione non trovata'; end if;
end $$;

revoke execute on all functions in schema public from anon;
grant execute on function public.create_couple(), public.join_couple(text), public.partner_status(),
  public.get_challenges(), public.complete_challenge(uuid), public.rate_challenge(uuid, int, text),
  public.my_couple(), public.my_partner(), public.current_week(), public.rome_today()
  to authenticated;
