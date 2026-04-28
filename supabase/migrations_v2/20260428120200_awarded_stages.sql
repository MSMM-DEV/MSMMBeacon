-- MSMM Beacon v2 — awarded_stages lookup (extensible from the app).
-- Referenced by projects.stage_id when status='awarded'.

set search_path = beacon_v2, public, extensions;

create table if not exists beacon_v2.awarded_stages (
  id          smallserial primary key,
  name        text not null unique,
  created_at  timestamptz not null default now()
);

insert into beacon_v2.awarded_stages (name) values
  ('Multi-Use Contract'),
  ('Single Use Contract (Project)'),
  ('AE Selected List')
on conflict (name) do nothing;
