-- Lets the demo switch off the look-up-before-retry guard to show the duplicate it prevents.
alter table workspaces add column idempotency_guard boolean not null default true;

-- Checks are recomputed on every change and stored, so lists can show counts without recomputing.
alter table invoices add column checks jsonb not null default '[]';
