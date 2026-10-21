-- Run once in the Supabase SQL editor to enable "Forgot password" on /admin.
create table if not exists admin_settings (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);

-- Only the server (service role key) reads or writes settings.
alter table admin_settings enable row level security;
