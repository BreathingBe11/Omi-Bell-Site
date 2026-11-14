-- Site-wide database lockdown for omibell.com (safe to run more than once).
--
-- The public ("anon") key is visible in the page source of the blog pages, as
-- every Supabase site's is. Row-level security decides what that key can do.
-- After this file runs, the public key can read ONLY published, already-dated
-- blog posts. Everything else (writers and their password hashes, resource
-- submissions and emails, Coterie bookings, admin settings, and every Smooth
-- Operators table) is reachable only through the site's own server code,
-- which uses the secret service-role key.
--
-- STEP 1 (optional): see the current state. Run this query alone first.
--
--   select c.relname as table, c.relrowsecurity as rls_on,
--          coalesce(string_agg(p.policyname || ' [' || p.cmd || ' to ' || array_to_string(p.roles, ',') || ']', '; '), '(no policies)') as policies
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--   left join pg_policies p on p.schemaname = n.nspname and p.tablename = c.relname
--   where n.nspname = 'public' and c.relkind = 'r'
--   group by c.relname, c.relrowsecurity order by 2, 1;
--
-- Any row with rls_on = false, or a policy for "anon"/"public" on a table
-- other than posts, is open to anyone holding the public key.
--
-- STEP 2: run everything below.

do $$
declare t text; pol record;
begin
  -- Private tables: no public access at all.
  foreach t in array array['writers', 'resources', 'coterie_bookings', 'admin_settings'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
        execute format('drop policy %I on public.%I', pol.policyname, t);
      end loop;
      if exists (select 1 from pg_roles where rolname = 'anon') then
        execute format('revoke all on public.%I from anon', t);
      end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then
        execute format('revoke all on public.%I from authenticated', t);
      end if;
    end if;
  end loop;

  -- Blog posts: the public can read published posts whose date has arrived. Nothing else.
  if to_regclass('public.posts') is not null then
    alter table public.posts enable row level security;
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'posts' loop
      execute format('drop policy %I on public.posts', pol.policyname);
    end loop;
    if exists (select 1 from pg_roles where rolname = 'anon') then
      revoke insert, update, delete, truncate on public.posts from anon;
      grant select on public.posts to anon;
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      revoke insert, update, delete, truncate on public.posts from authenticated;
      grant select on public.posts to authenticated;
    end if;
    create policy "Public reads published posts" on public.posts
      for select to anon, authenticated
      using (published = true and date <= now());
  end if;

  -- Every other table in the public schema (including all so_* tables): make
  -- sure row-level security is on. With no policies, the public key gets nothing.
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and c.relname <> 'posts' and not c.relrowsecurity loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- File storage: no bucket should be public except ones meant for public images.
-- This lists them so you can check; it changes nothing.
select id, public from storage.buckets order by id;
