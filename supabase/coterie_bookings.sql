-- Run once in the Supabase SQL editor to enable /coterie bookings.
create table if not exists coterie_bookings (
  id          bigint generated always as identity primary key,
  slot_start  timestamptz not null unique,
  name        text not null,
  phone       text not null,
  email       text not null,
  service     text not null,
  created_at  timestamptz not null default now()
);

-- Only the server (service role key) reads or writes bookings.
alter table coterie_bookings enable row level security;
