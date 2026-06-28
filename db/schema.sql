-- DealFinder schema — paste this whole file into your Supabase project's SQL Editor and hit "Run".
-- (Or just run `npm run db:setup`, which applies the same thing over the DIRECT_URL connection.)
-- This is the ONLY table DealFinder uses. Your data stays in YOUR project — nobody else can see it.

create table if not exists foreclosure_leads (
  case_number      text primary key,
  county           text default 'Orange',
  plaintiff        text,
  defendant        text,
  type             text,
  property_address text,
  principal_due    numeric,
  interest_owed    numeric,
  total_owed       numeric,
  owed_with_buffer numeric,
  zillow_value     numeric,
  spread           numeric,
  flagged          boolean,
  review_status    text,
  review_reason    text,
  complaint_url    text,
  value_url        text,
  docket_url       text,
  knock_status     text default 'new',
  knock_note       text,
  scan_month       int,
  scan_year        int,
  notified_at      timestamptz,           -- set once a lead has been sent in the daily Telegram report
  scanned_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- Backfill for projects created before notified_at existed (safe to re-run).
alter table foreclosure_leads add column if not exists notified_at timestamptz;

-- Indexes that make the dashboard + reports fast.
create index if not exists idx_fl_flagged    on foreclosure_leads (flagged);
create index if not exists idx_fl_county     on foreclosure_leads (county);
create index if not exists idx_fl_scan       on foreclosure_leads (scan_year, scan_month);
create index if not exists idx_fl_spread     on foreclosure_leads (spread desc);
create index if not exists idx_fl_notified   on foreclosure_leads (notified_at);
