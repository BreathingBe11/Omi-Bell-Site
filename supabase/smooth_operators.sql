-- Smooth Operators — schema migration (v1)
--
-- Run once in the Supabase SQL editor (or `psql "$SO_DATABASE_URL" -f ...`).
-- Safe to re-run: every statement is idempotent.
--
-- Security model: every table has row level security ENABLED with NO policies
-- and all privileges revoked from the `anon` and `authenticated` roles, so the
-- public Supabase REST API cannot read or write any of this data. All access
-- goes through the /api/so server, which connects with a server-only database
-- URL and enforces enrollment, release and ownership checks itself.
--
-- Timestamps are stored as timestamptz (UTC). Cohort scheduling uses an IANA
-- timezone name stored on the cohort.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- profiles
create table if not exists so_profiles (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  email         text not null,
  display_name  text,
  timezone      text,
  role          text not null default 'member' check (role in ('member', 'admin')),
  email_prefs   jsonb not null default '{}'::jsonb,  -- optional reminder opt-ins; transactional mail ignores this
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ----------------------------------------------------------------- cohorts
create table if not exists so_cohorts (
  id                     uuid primary key default gen_random_uuid(),
  slug                   text not null unique,
  name                   text not null,
  start_date             date not null,
  days_count             int  not null default 21 check (days_count between 1 and 60),
  timezone               text not null default 'America/Los_Angeles',
  unlock_time            time not null default '00:00',
  intro_opens_at         timestamptz not null,
  enrollment_opens_at    timestamptz,                  -- null = open now
  enrollment_closes_at   timestamptz,                  -- null = closes when the cohort ends
  currency               text not null default 'usd' check (currency = 'usd'),
  regular_price_cents    int  not null check (regular_price_cents > 0),
  intro_price_cents      int  check (intro_price_cents > 0),
  price_cutoff_at        timestamptz,                  -- intro price applies strictly before this instant
  checkout_ttl_minutes   int  not null default 60 check (checkout_ttl_minutes between 30 and 1440),
  access_policy          text not null default 'unset' check (access_policy in ('unset', 'until_date', 'indefinite')),
  access_ends_at         timestamptz,
  refund_access_action   text not null default 'suspend' check (refund_access_action in ('suspend', 'keep')),
  dispute_access_action  text not null default 'keep'    check (dispute_access_action in ('suspend', 'keep')),
  call_join_window_minutes int not null default 15 check (call_join_window_minutes between 0 and 240),
  sales_enabled          boolean not null default false,
  settings_confirmed_at  timestamptz,                  -- owner confirmed dates/times/prices
  settings_confirmed_by  text,
  is_default             boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (access_policy <> 'until_date' or access_ends_at is not null)
);
create unique index if not exists so_cohorts_one_default on so_cohorts (is_default) where is_default;

create table if not exists so_weeks (
  cohort_id    uuid not null references so_cohorts(id) on delete cascade,
  week_number  int  not null check (week_number between 1 and 9),
  pillar       text not null,
  title        text not null,
  assignment   text,
  primary key (cohort_id, week_number)
);

-- --------------------------------------------------------------- resources
create table if not exists so_resources (
  id                uuid primary key default gen_random_uuid(),
  cohort_id         uuid not null references so_cohorts(id) on delete cascade,
  kind              text not null check (kind in ('template', 'practice', 'replay', 'other')),
  title             text not null,
  purpose           text,
  description       text,
  pillar            text check (pillar in ('standards', 'systems', 'scorecards')),
  source_type       text not null default 'file' check (source_type in ('file', 'link')),
  storage_path      text,                 -- private bucket path; never sent to browsers
  file_name         text,
  mime_type         text,
  file_size         bigint,
  external_url      text,
  practice_type     text check (practice_type in ('breathwork', 'meditation')),
  duration_seconds  int check (duration_seconds >= 0),
  transcript        text,
  release_mode      text not null default 'with_day' check (release_mode in ('with_day', 'at_time', 'immediately')),
  release_at        timestamptz,
  status            text not null default 'draft' check (status in ('draft', 'published')),
  version           int  not null default 1,
  is_sample         boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (release_mode <> 'at_time' or release_at is not null)
);

-- -------------------------------------------------------------------- days
create table if not exists so_days (
  id                 uuid primary key default gen_random_uuid(),
  cohort_id          uuid not null references so_cohorts(id) on delete cascade,
  day_number         int  not null check (day_number >= 1),
  title              text not null,
  preview_summary    text,                -- the ONLY body text sent for locked days
  preview_published  boolean not null default false,  -- title/summary approved for locked-day previews
  purpose            text,
  content            text,
  reflection_prompt  text,
  prompt_version     int  not null default 1,
  action_title       text,
  action_body        text,
  status             text not null default 'draft' check (status in ('draft', 'published')),
  published_at       timestamptz,
  is_sample          boolean not null default true,  -- provisional curriculum, not owner-approved
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (cohort_id, day_number)
);

create table if not exists so_day_resources (
  day_id       uuid not null references so_days(id) on delete cascade,
  resource_id  uuid not null references so_resources(id) on delete cascade,
  role         text not null check (role in ('practice', 'template', 'supporting')),
  sort         int  not null default 0,
  primary key (day_id, resource_id)
);
create unique index if not exists so_day_resources_one_practice on so_day_resources (day_id) where role = 'practice';

-- ----------------------------------------------------- purchases & access
create table if not exists so_purchases (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references auth.users(id) on delete restrict,
  cohort_id                 uuid not null references so_cohorts(id) on delete restrict,
  status                    text not null default 'created' check (status in (
                              'created', 'open', 'pending', 'paid', 'failed', 'expired', 'canceled',
                              'refunded', 'partially_refunded', 'disputed')),
  price_tier                text not null check (price_tier in ('intro', 'regular')),
  amount_cents              int  not null check (amount_cents > 0),
  currency                  text not null default 'usd',
  quoted_at                 timestamptz not null default now(),
  expires_at                timestamptz,
  stripe_session_id         text unique,
  stripe_payment_intent_id  text unique,
  checkout_url              text,
  amount_paid_cents         int,
  livemode                  boolean,
  needs_review              text,          -- non-null = something an admin should look at
  paid_at                   timestamptz,
  refunded_at               timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
-- At most one in-flight checkout per member and cohort (stops duplicate sessions from repeated clicks).
create unique index if not exists so_purchases_one_inflight
  on so_purchases (user_id, cohort_id) where status in ('created', 'open', 'pending');

create table if not exists so_enrollments (
  id                         uuid primary key default gen_random_uuid(),
  user_id                    uuid not null references auth.users(id) on delete cascade,
  cohort_id                  uuid not null references so_cohorts(id) on delete restrict,
  purchase_id                uuid references so_purchases(id),
  source                     text not null default 'stripe' check (source in ('stripe', 'manual')),
  access_state               text not null default 'active' check (access_state in (
                               'active', 'suspended', 'refunded', 'disputed', 'revoked')),
  is_test                    boolean not null default false,  -- created from a Stripe test-mode payment
  access_ends_at             timestamptz,                     -- per-member override of the cohort policy
  activated_at               timestamptz not null default now(),
  confirmation_email_sent_at timestamptz,
  admin_note                 text,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  unique (user_id, cohort_id)
);

-- --------------------------------------------------------- member writing
create table if not exists so_journal_entries (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  cohort_id        uuid not null references so_cohorts(id) on delete cascade,
  day_id           uuid not null references so_days(id) on delete cascade,
  body             text not null default '',
  prompt_snapshot  text,          -- the question as it read when the member first answered
  prompt_version   int,
  revision         int  not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, cohort_id, day_id)
);

create table if not exists so_day_progress (
  user_id       uuid not null references auth.users(id) on delete cascade,
  cohort_id     uuid not null references so_cohorts(id) on delete cascade,
  day_id        uuid not null references so_days(id) on delete cascade,
  started_at    timestamptz,     -- first meaningful saved action (reflection saved, practice played)
  completed_at  timestamptz,     -- manual, reversible
  updated_at    timestamptz not null default now(),
  primary key (user_id, cohort_id, day_id)
);

create table if not exists so_playback (
  user_id           uuid not null references auth.users(id) on delete cascade,
  resource_id       uuid not null references so_resources(id) on delete cascade,
  position_seconds  int  not null default 0 check (position_seconds >= 0),
  updated_at        timestamptz not null default now(),
  primary key (user_id, resource_id)
);

create table if not exists so_introductions (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  cohort_id             uuid not null references so_cohorts(id) on delete cascade,
  preferred_name        text not null,
  business_name         text not null,
  business_description  text not null,
  operating_challenge   text not null,
  website_url           text,
  photo_path            text,
  moderation_state      text not null default 'visible' check (moderation_state in ('visible', 'hidden')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (user_id, cohort_id)
);

-- ------------------------------------------------------------------- calls
create table if not exists so_calls (
  id                   uuid primary key default gen_random_uuid(),
  cohort_id            uuid not null references so_cohorts(id) on delete cascade,
  title                text not null default 'Solutions Seat',
  description          text,
  starts_at            timestamptz not null,
  duration_minutes     int  not null default 60 check (duration_minutes between 5 and 480),
  meeting_url          text,           -- only sent to members inside the joining window
  join_window_minutes  int  check (join_window_minutes between 0 and 240),
  replay_resource_id   uuid references so_resources(id) on delete set null,
  replay_published     boolean not null default false,
  status               text not null default 'draft' check (status in ('draft', 'scheduled', 'canceled')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table if not exists so_call_challenges (
  id          uuid primary key default gen_random_uuid(),
  cohort_id   uuid not null references so_cohorts(id) on delete cascade,
  call_id     uuid references so_calls(id) on delete set null,
  user_id     uuid not null references auth.users(id) on delete cascade,
  body        text not null check (char_length(body) between 1 and 1200),
  status      text not null default 'submitted' check (status in ('submitted', 'reviewed', 'discussed', 'archived')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ------------------------------------------------------- content & config
create table if not exists so_faqs (
  id          uuid primary key default gen_random_uuid(),
  cohort_id   uuid references so_cohorts(id) on delete cascade,
  question    text not null,
  answer      text not null default '',
  sort        int  not null default 0,
  audience    text not null default 'both' check (audience in ('public', 'members', 'both')),
  status      text not null default 'draft' check (status in ('draft', 'published')),
  updated_at  timestamptz not null default now(),
  check (status = 'draft' or char_length(trim(answer)) > 0)
);

create table if not exists so_site_content (
  key         text primary key,
  value       text not null default '',
  status      text not null default 'draft' check (status in ('draft', 'published')),
  updated_at  timestamptz not null default now(),
  updated_by  text
);

-- ------------------------------------------------------------- operations
create table if not exists so_webhook_events (
  id            text primary key,        -- Stripe event id (dedupe key)
  type          text not null,
  livemode      boolean,
  object_id     text,
  status        text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed')),
  error         text,
  attempts      int  not null default 1,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz
);

create table if not exists so_admin_audit_log (
  id          bigint generated always as identity primary key,
  actor       text not null,
  action      text not null,
  entity      text,
  entity_id   text,
  before      jsonb,
  after       jsonb,
  created_at  timestamptz not null default now()
);

-- Funnel/operations events. Never stores journal text, challenge text or payment details.
create table if not exists so_events (
  id          bigint generated always as identity primary key,
  name        text not null,
  user_id     uuid,
  cohort_id   uuid,
  day_number  int,
  ref_id      text,
  created_at  timestamptz not null default now()
);
create index if not exists so_events_name_idx on so_events (name, created_at);

create table if not exists so_email_log (
  dedupe_key  text primary key,
  kind        text not null,
  user_id     uuid,
  status      text not null,
  created_at  timestamptz not null default now()
);

create table if not exists so_rate_limits (
  key           text primary key,
  window_start  timestamptz not null,
  count         int not null
);

-- ------------------------------------------------- v2: fit check & review
-- Hidden seat cap (never shown publicly; the site just says seats are full).
alter table so_cohorts add column if not exists seat_limit int default 30 check (seat_limit is null or seat_limit > 0);

-- Paid members start "pending" review. Omi approves them, or marks them
-- not a fit (full refund). Once approved, the enrollment is non-refundable.
alter table so_enrollments add column if not exists review_state text not null default 'pending';
alter table so_enrollments add column if not exists reviewed_at timestamptz;
alter table so_enrollments add column if not exists reviewed_by text;
alter table so_enrollments add column if not exists review_note text;
do $$ begin
  alter table so_enrollments add constraint so_enrollments_review_state_check
    check (review_state in ('pending', 'approved', 'not_a_fit'));
exception when duplicate_object then null; end $$;

-- Fit check, required before payment. Private to the member and admins:
-- never shown in introductions, analytics or logs.
create table if not exists so_intakes (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  cohort_id            uuid not null references so_cohorts(id) on delete cascade,
  first_name           text not null,
  last_name            text not null,
  business_name        text not null,
  website_url          text,
  no_website           boolean not null default false,
  phone                text not null,
  address_line1        text not null,
  address_line2        text,
  city                 text not null,
  state                text not null,
  postal_code          text not null,
  country              text not null default 'United States',
  business_stage       text not null,
  revenue_to_date      text not null,
  years_in_business    text not null,
  prior_ops_work       boolean not null,
  has_full_time_staff  boolean not null,
  team_size            text not null,
  ops_questions        text not null,
  policy_ack_at        timestamptz not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (user_id, cohort_id)
);

-- ------------------------------------------- v3: admin workspace (review, refunds, email, support)
-- Staff roles. owner: everything; admin: everything except staff management;
-- support: members, questions and challenges, but no decisions, refunds, finance or settings.
alter table so_profiles drop constraint if exists so_profiles_role_check;
alter table so_profiles add constraint so_profiles_role_check check (role in ('member', 'support', 'admin', 'owner'));

-- Shown to buyers before payment and while their enrollment is under review.
alter table so_cohorts add column if not exists review_turnaround text not null default 'within 3 business days, and always before the cohort begins';
alter table so_cohorts add column if not exists send_refund_completed_email boolean not null default false;

-- Review states: awaiting_submission is derived; stored states are pending / approved / rejected.
update so_enrollments set review_state = 'rejected' where review_state = 'not_a_fit';
alter table so_enrollments drop constraint if exists so_enrollments_review_state_check;
alter table so_enrollments add constraint so_enrollments_review_state_check check (review_state in ('pending', 'approved', 'rejected'));
alter table so_enrollments add column if not exists review_version int not null default 0;  -- concurrency guard for decisions

-- Applications: drafts are saved; only explicit, validated submissions enter review.
alter table so_intakes add column if not exists status text not null default 'submitted';
alter table so_intakes add column if not exists submitted_at timestamptz;
alter table so_intakes add column if not exists version int not null default 1;
alter table so_intakes add column if not exists policy_version text;
alter table so_intakes add column if not exists policy_text text;
update so_intakes set submitted_at = coalesce(submitted_at, created_at) where status = 'submitted';
do $$ declare c text; begin
  foreach c in array array['first_name','last_name','business_name','phone','address_line1','city','state','postal_code',
    'business_stage','revenue_to_date','years_in_business','prior_ops_work','has_full_time_staff','team_size','ops_questions','policy_ack_at']
  loop execute format('alter table so_intakes alter column %I drop not null', c); end loop;
end $$;
alter table so_intakes drop constraint if exists so_intakes_status_check;
alter table so_intakes add constraint so_intakes_status_check check (status in ('draft', 'submitted'));

create table if not exists so_intake_versions (
  id              uuid primary key default gen_random_uuid(),
  intake_id       uuid not null references so_intakes(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  cohort_id       uuid not null references so_cohorts(id) on delete cascade,
  version         int  not null,
  data            jsonb not null,
  policy_version  text,
  submitted_at    timestamptz not null default now(),
  unique (intake_id, version)
);

create table if not exists so_review_decisions (
  id              uuid primary key default gen_random_uuid(),
  enrollment_id   uuid not null references so_enrollments(id) on delete cascade,
  decision        text not null check (decision in ('approved', 'rejected', 'reopened')),
  intake_version  int,
  actor           text not null,
  member_message  text,           -- shown to the member in the decision email
  internal_note   text,           -- never sent to the member
  created_at      timestamptz not null default now()
);

alter table so_purchases add column if not exists stripe_charge_id text;
alter table so_purchases add column if not exists receipt_url text;
alter table so_purchases add column if not exists tax_cents int;
alter table so_purchases add column if not exists fee_cents int;
alter table so_purchases add column if not exists refunded_cents int not null default 0;

create table if not exists so_refund_attempts (
  id               uuid primary key default gen_random_uuid(),
  purchase_id      uuid not null references so_purchases(id) on delete restrict,
  enrollment_id    uuid references so_enrollments(id) on delete set null,
  amount_cents     int,
  currency         text not null default 'usd',
  status           text not null default 'queued' check (status in ('queued', 'pending', 'succeeded', 'failed', 'requires_action', 'canceled')),
  stripe_refund_id text unique,
  idempotency_key  text not null unique,
  failure_reason   text,
  needs_attention  boolean not null default false,
  source           text not null default 'review' check (source in ('review', 'external')),
  actor            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
-- One live refund attempt per purchase: duplicates are impossible.
create unique index if not exists so_refund_attempts_one_live on so_refund_attempts (purchase_id)
  where status in ('queued', 'pending', 'succeeded', 'requires_action') and source = 'review';

create table if not exists so_email_templates (
  key         text primary key,
  subject     text not null,
  body        text not null,
  version     int  not null default 1,
  enabled     boolean not null default true,
  updated_at  timestamptz not null default now(),
  updated_by  text
);
create table if not exists so_email_template_versions (
  key         text not null,
  version     int  not null,
  subject     text not null,
  body        text not null,
  created_at  timestamptz not null default now(),
  created_by  text,
  primary key (key, version)
);

create table if not exists so_email_outbox (
  id                uuid primary key default gen_random_uuid(),
  dedupe_key        text not null unique,
  template_key      text not null,
  template_version  int,
  category          text not null default 'transactional' check (category in ('transactional', 'optional', 'test')),
  user_id           uuid,
  cohort_id         uuid,
  to_email          text not null,
  subject           text not null,
  body_text         text not null,
  edited            boolean not null default false,
  related_type      text,
  related_id        text,
  status            text not null default 'queued' check (status in ('queued', 'sending', 'submitted', 'delivered', 'bounced', 'complained', 'failed', 'skipped')),
  provider_id       text,
  attempts          int not null default 0,
  last_error        text,
  resend_of         uuid references so_email_outbox(id),
  actor             text,
  created_at        timestamptz not null default now(),
  submitted_at      timestamptz,
  delivered_at      timestamptz,
  updated_at        timestamptz not null default now()
);
create index if not exists so_email_outbox_user_idx on so_email_outbox (user_id, created_at);
create index if not exists so_email_outbox_status_idx on so_email_outbox (status);

create table if not exists so_support_threads (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  cohort_id     uuid references so_cohorts(id) on delete cascade,
  category      text not null check (category in ('program', 'account_access', 'billing_refund', 'resources', 'application', 'other')),
  subject       text not null,
  status        text not null default 'new' check (status in ('new', 'in_progress', 'resolved')),
  last_message_at timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create table if not exists so_support_messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references so_support_threads(id) on delete cascade,
  author_type text not null check (author_type in ('member', 'staff')),
  author      text,
  internal    boolean not null default false,   -- staff-only note, never shown or emailed to the member
  body        text not null check (char_length(body) between 1 and 5000),
  created_at  timestamptz not null default now()
);

create table if not exists so_admin_notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  cohort_id   uuid references so_cohorts(id) on delete cascade,
  author      text not null,
  body        text not null check (char_length(body) between 1 and 4000),
  created_at  timestamptz not null default now()
);

-- Solutions Seat challenge details and facilitator workflow.
alter table so_call_challenges add column if not exists working_on text;
alter table so_call_challenges add column if not exists stuck_on text;
alter table so_call_challenges add column if not exists help_wanted text;
alter table so_call_challenges add column if not exists share_permission boolean;
alter table so_call_challenges add column if not exists facilitator_note text;
alter table so_call_challenges alter column body drop not null;
alter table so_call_challenges drop constraint if exists so_call_challenges_body_check;
update so_call_challenges set status = case status when 'reviewed' then 'selected' when 'archived' then 'follow_up' else status end;
alter table so_call_challenges drop constraint if exists so_call_challenges_status_check;
alter table so_call_challenges add constraint so_call_challenges_status_check check (status in ('submitted', 'selected', 'discussed', 'follow_up'));

-- Scheduled publication: a published day with publish_at in the future stays hidden until then.
alter table so_days add column if not exists publish_at timestamptz;

-- ------------------------------------------- v4: free journal entries, announcements
-- Journal entries a member writes on their own, not tied to a daily prompt.
-- Private to the member, exactly like daily reflections.
create table if not exists so_journal_notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  cohort_id   uuid not null references so_cohorts(id) on delete cascade,
  title       text,
  body        text not null default '',
  revision    int  not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists so_journal_notes_user_idx on so_journal_notes (user_id, cohort_id, updated_at desc);

-- Announcements shown at the top of Today for approved members.
create table if not exists so_announcements (
  id          uuid primary key default gen_random_uuid(),
  cohort_id   uuid not null references so_cohorts(id) on delete cascade,
  title       text not null,
  body        text not null default '',
  status      text not null default 'draft' check (status in ('draft', 'published')),
  pinned      boolean not null default false,
  publish_at  timestamptz,          -- optional: hidden until this time
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  text
);

-- Bug reports share the questions inbox.
alter table so_support_threads drop constraint if exists so_support_threads_category_check;
alter table so_support_threads add constraint so_support_threads_category_check
  check (category in ('program', 'account_access', 'billing_refund', 'resources', 'application', 'other', 'bug'));

-- --------------------------------------------------------------- security
do $$
declare t text;
begin
  foreach t in array array[
    'so_profiles','so_cohorts','so_weeks','so_resources','so_days','so_day_resources',
    'so_purchases','so_enrollments','so_journal_entries','so_day_progress','so_playback',
    'so_introductions','so_calls','so_call_challenges','so_faqs','so_site_content',
    'so_webhook_events','so_admin_audit_log','so_events','so_email_log','so_rate_limits','so_intakes',
    'so_intake_versions','so_review_decisions','so_refund_attempts','so_email_templates','so_email_template_versions',
    'so_email_outbox','so_support_threads','so_support_messages','so_admin_notes',
    'so_journal_notes','so_announcements']
  loop
    execute format('alter table %I enable row level security', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on %I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on %I from authenticated', t);
    end if;
  end loop;
end $$;

-- Private storage bucket for toolkit files, audio, replays and intro photos.
-- Objects are only ever reached through short-lived signed URLs issued by the server.
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('smooth-operators', 'smooth-operators', false, 524288000, array[
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/msword', 'application/vnd.ms-excel', 'text/csv', 'text/plain',
      'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/aac',
      'video/mp4', 'image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update set public = false;
  end if;
end $$;
