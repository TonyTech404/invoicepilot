-- InvoicePilot schema.
-- Each visitor gets a workspace so demo data never leaks between people.

create extension if not exists pgcrypto;

-- ── Shared reference data ───────────────────────────────────────────────────

create table accounts (
  code             text primary key,            -- MYOB-style account number, e.g. 5-1100
  name             text not null,
  kind             text not null check (kind in ('asset', 'cost_of_sales', 'expense')),
  default_tax_code text not null,
  description      text not null,               -- what belongs here; shown to the AI coder
  active           boolean not null default true,
  myob_uid         uuid not null unique
);

create table tax_codes (
  code     text primary key,                    -- GST, FRE, N-T
  name     text not null,
  rate     numeric(5,2) not null,
  myob_uid uuid not null unique
);

-- ── Per-visitor data ────────────────────────────────────────────────────────

create table workspaces (
  id              uuid primary key default gen_random_uuid(),
  company_file_id uuid not null unique default gen_random_uuid(),  -- the mock MYOB company file
  myob_mode       text not null default 'healthy'
                  check (myob_mode in ('healthy', 'flaky', 'lost_responses')),
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now()
);

create table suppliers (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  name         text not null,
  abn          text,                            -- digits only
  myob_uid     uuid,                            -- set once the supplier exists in MYOB
  created_at   timestamptz not null default now(),
  unique (workspace_id, abn)
);

create table invoices (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces on delete cascade,
  status         text not null default 'uploaded' check (status in
                   ('uploaded', 'extracted', 'needs_review', 'approved', 'posting', 'posted', 'failed', 'rejected')),

  file_name      text not null,
  file_mime      text not null,
  file_size      int not null,
  file_sha256    text not null,
  file_url       text,                          -- set for seeded invoices served as static files

  supplier_id    uuid references suppliers on delete set null,
  supplier_name  text,
  supplier_abn   text,
  invoice_number text,
  invoice_date   date,
  due_date       date,
  po_number      text,
  currency       text not null default 'AUD',
  subtotal       numeric(12,2),
  tax            numeric(12,2),
  total          numeric(12,2),

  -- What Document Intelligence returned, kept so a reviewer can see where each value came from.
  confidence     jsonb not null default '{}',   -- field -> 0..1
  boxes          jsonb not null default '{}',   -- field -> { page, polygon }
  pages          jsonb not null default '[]',   -- [{ width, height, unit }]
  raw_vendor     text,                          -- vendor name exactly as read

  extract_ms     int,
  code_ms        int,
  ai_tokens      int,
  ai_notes       text,

  myob_bill_uid  uuid,
  posted_at      timestamptz,
  last_error     text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index invoices_ws_created on invoices (workspace_id, created_at desc);
create index invoices_ws_supplier_number on invoices (workspace_id, supplier_id, invoice_number);

create table invoice_files (
  invoice_id uuid primary key references invoices on delete cascade,
  bytes      bytea not null
);

create table invoice_lines (
  id              uuid primary key default gen_random_uuid(),
  invoice_id      uuid not null references invoices on delete cascade,
  position        int not null,
  description     text not null default '',
  quantity        numeric(12,3),
  unit_price      numeric(12,4),
  amount          numeric(12,2) not null default 0,
  tax_code        text references tax_codes,
  account_code    text references accounts,
  -- The AI's suggestion is kept apart from the final value so corrections can be learned from.
  ai_account_code text,
  ai_tax_code     text,
  ai_confidence   real,
  ai_reason       text,
  read_confidence real,
  box             jsonb,
  unique (invoice_id, position)
);

create table events (
  id           bigserial primary key,
  invoice_id   uuid not null references invoices on delete cascade,
  at           timestamptz not null default now(),
  kind         text not null,
  message      text not null,
  data         jsonb
);
create index events_invoice on events (invoice_id, at);

-- ── MYOB sync (outbox) ──────────────────────────────────────────────────────

create table sync_jobs (
  id              uuid primary key default gen_random_uuid(),
  invoice_id      uuid not null unique references invoices on delete cascade,
  workspace_id    uuid not null references workspaces on delete cascade,
  state           text not null default 'pending'
                  check (state in ('pending', 'retrying', 'succeeded', 'failed')),
  attempts        int not null default 0,
  -- True when an earlier attempt may have reached MYOB (timeout, dropped connection).
  -- The next attempt must look the bill up before posting again.
  uncertain       boolean not null default false,
  next_attempt_at timestamptz not null default now(),
  locked_until    timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index sync_jobs_due on sync_jobs (state, next_attempt_at);

create table sync_attempts (
  id          bigserial primary key,
  job_id      uuid not null references sync_jobs on delete cascade,
  at          timestamptz not null default now(),
  attempt     int not null,
  step        text not null,                     -- lookup | supplier | post
  request     text not null,                     -- e.g. POST /Purchase/Bill/Service
  status      int,                               -- HTTP status, null on timeout
  outcome     text not null,                     -- ok | retry | uncertain | fatal | found
  detail      text,
  duration_ms int not null
);

-- ── Mock MYOB company file ──────────────────────────────────────────────────
-- Stands in for MYOB AccountRight. The API in api/src/myob/mock.ts speaks MYOB's
-- request and response shapes on top of these tables.

create table myob_suppliers (
  uid             uuid primary key default gen_random_uuid(),
  company_file_id uuid not null references workspaces (company_file_id) on delete cascade,
  name            text not null,
  abn             text,
  created_at      timestamptz not null default now()
);

create table myob_bills (
  uid                     uuid primary key default gen_random_uuid(),
  company_file_id         uuid not null references workspaces (company_file_id) on delete cascade,
  number                  text not null,
  supplier_uid            uuid not null references myob_suppliers on delete cascade,
  supplier_invoice_number text,
  date                    date not null,
  is_tax_inclusive        boolean not null default false,
  subtotal                numeric(12,2) not null,
  tax                     numeric(12,2) not null,
  total                   numeric(12,2) not null,
  lines                   jsonb not null,
  comment                 text,
  source                  text not null default 'api' check (source in ('api', 'manual')),
  row_version             int not null default 1,
  created_at              timestamptz not null default now()
);
create index myob_bills_cf on myob_bills (company_file_id, supplier_invoice_number);

-- ── Housekeeping ────────────────────────────────────────────────────────────

-- Document Intelligence results by file hash: re-uploading a file never spends free-tier pages twice.
create table extraction_cache (
  sha256     text primary key,
  result     jsonb not null,
  created_at timestamptz not null default now()
);

create table rate_limits (
  key          text not null,
  window_start timestamptz not null,
  count        int not null default 0,
  primary key (key, window_start)
);
