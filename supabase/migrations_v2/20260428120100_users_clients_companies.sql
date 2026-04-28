-- MSMM Beacon v2 — users + clients + companies (the master tables).
--
-- Same shape as live beacon: users decoupled from auth.users (matched on
-- email at first login), clients keyed on (name, district), companies keyed
-- on name with a singleton MSMM row. Role column lives on users from day one
-- (live beacon added it later in 20260423120000_user_roles.sql).

-- Each Studio paste runs in its own session, so the search_path set in 01
-- doesn't carry forward. Setting it here keeps unqualified references to
-- enum types (org_type_enum, etc.) and helper functions resolvable.
set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- Users
--------------------------------------------------------------------------------
create table if not exists beacon_v2.users (
  id             uuid primary key default gen_random_uuid(),
  auth_user_id   uuid unique references auth.users(id) on delete set null,
  login_name     text unique,
  first_name     text,
  last_name      text,
  display_name   text,
  short_name     text,
  email          text not null,
  department     text,
  employee_type  text,
  location       text,
  is_enabled     boolean not null default true,
  role           text not null default 'User'
                 check (role in ('Admin','User')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
-- Case-insensitive unique on email (replaces v1's citext-based unique).
create unique index if not exists users_email_lower_uniq
  on beacon_v2.users (lower(email));

drop trigger if exists touch_users on beacon_v2.users;
create trigger touch_users before update on beacon_v2.users
  for each row execute function beacon_v2.touch_updated_at();

-- First-login trigger: when a Supabase auth.users row is created, match it
-- to the pre-seeded beacon_v2.users row by email and link via auth_user_id.
-- If no roster row exists yet, create a minimal one.
create or replace function beacon_v2.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = beacon_v2, public, auth as $$
begin
  update beacon_v2.users
     set auth_user_id = new.id, updated_at = now()
   where lower(email) = lower(new.email)
     and auth_user_id is null;
  if not found then
    insert into beacon_v2.users (auth_user_id, email, display_name)
    values (new.id, new.email, split_part(new.email,'@',1))
    on conflict (lower(email)) do update set auth_user_id = excluded.auth_user_id;
  end if;
  return new;
end;
$$;

-- The trigger on auth.users is global. If the live beacon schema is also
-- applied to this database, both triggers will fire on a new auth user —
-- harmless because each writes to its own schema's users table. Once v2 is
-- the only live schema, drop the v1 trigger.
drop trigger if exists on_auth_user_created_v2 on auth.users;
create trigger on_auth_user_created_v2
  after insert on auth.users
  for each row execute function beacon_v2.handle_new_auth_user();

-- Roster seed (30 users from the Replicon export). Raj is the lone Admin.
insert into beacon_v2.users (login_name, first_name, last_name, display_name, short_name, email, department, employee_type, location, role) values
  ('sdouglas',   'Scott',     'Douglas',   'Scott',     'Scott D.',  'scott@msmmeng.com',                     'Engineering',         'Full Time Salary',  'New Orleans', 'User'),
  ('bbertucci',  'Benjamin',  'Bertucci',  'Ben',       'Ben',       'BBertucci@msmmeng.com',                 'Engineering',         'Full Time Salary',  'New Orleans', 'User'),
  ('manish',     'Manish',    'Mardia',    'Manish',    'Manish',    'mmardia@msmmeng.com',                   'Engineering',         'Full Time Salary',  'New Orleans', 'User'),
  ('milan',      'Milan',     'Mardia',    'Milan',     'Milan',     'Milan@msmmeng.com',                     'Engineering',         'Full Time Salary',  'New York',    'User'),
  ('mayank',     'Mayank',    'Mardia',    'Mayank',    'Mayank',    'Mayank@msmmeng.com',                    'Engineering',         'Full Time Salary',  'New York',    'User'),
  ('mwingate',   'Mark',      'Wingate',   'Mark',      'Mark',      'mwingate@msmmeng.com',                  'Engineering',         'Full Time Salary',  'New Orleans', 'User'),
  ('rmehta',     'Raj',       'Mehta',     'Raj',       'Raj',       'rmehta@msmmeng.com',                    'Engineering',         'Full Time Salary',  'New Orleans', 'Admin'),
  ('schehardy',  'Scott',     'Chehardy',  'Scott',     'Scott C.',  'schehardy@msmmeng.com',                 'Engineering',         'Full Time Salary',  'Memphis',     'User'),
  ('ecurson',    'Eric',      'Curson',    'Eric',      'Eric',      'ecurson@msmmeng.com',                   'Engineering',         'Full Time Salary',  'New Orleans', 'User'),
  ('jwilson',    'Jim',       'Wilson',    'Jim',       'Jim',       'jwilson@msmmeng.com',                   'Engineering',         'Full Time Salary',  'New Orleans', 'User'),
  ('pmansfield', 'Patrick',   'Mansfield', 'Patrick',   'Patrick',   'pmansfield@msmmeng.com',                'Engineering',         'Full Time Salary',  'New Orleans', 'User'),
  ('arichards',  'Autumn',    'Richards',  'Autumn',    'Autumn',    'ARichards@msmmeng.com',                 'Engineering',         'Full Time Salary',  'New Orleans', 'User'),
  ('dalexander', 'Dani',      'Alexander', 'Dani',      'Dani',      'dalexander@msmmeng.com',                'Project Management',  'Full Time Salary',  'New Orleans', 'User'),
  ('cerwin',     'Cierra',    'Erwin',     'Cierra',    'Cierra',    'cerwin@msmmeng.com',                    'Project Management',  'Full Time Salary',  'New Orleans', 'User'),
  ('rroessler',  'Ryan',      'Roessler',  'Ryan',      'Ryan',      'Rroessler@msmmeng.com',                 'Project Management',  'Full Time Salary',  'New Orleans', 'User'),
  ('ccarriere',  'Chantrell', 'Carriere',  'Chantrell', 'Chantrell', 'ccarriere@msmmeng.com',                 'Project Management',  'Full Time Salary',  'New Orleans', 'User'),
  ('dshulman',   'David',     'Shulman',   'David',     'David S.',  'dshulman@msmmeng.com',                  'Project Management',  'Full Time Salary',  'New Orleans', 'User'),
  ('cmills',     'Chris',     'Mills',     'Chris',     'Chris',     'cmills@msmmeng.com',                    'Engineering',         'Full Time Salary',  'New Orleans', 'User'),
  ('sseiler',    'Stuart',    'Seiler',    'Stuart',    'Stuart',    'SSeiler@msmmeng.com',                   'Engineering',         'Full Time Salary',  'New Orleans', 'User'),
  ('binh',       'Binh',      'Li',        'Binh',      'Binh',      'Binh@msmmeng.com',                      'Engineering',         'Full Time Hourly',  'New Orleans', 'User'),
  ('cray',       'Clay',      'Ray',       'Clay',      'Clay',      'cray@msmmeng.com',                      'Engineering',         'Full Time Salary',  'New Orleans', 'User'),
  ('pmeric',     'Philip',    'Meric',     'Philip',    'Phil',      'pmeric@msmmeng.com',                    'Project Management',  'Full Time Salary',  'New Orleans', 'User'),
  ('ggrimes',    'George',    'Grimes',    'George',    'George',    'GGrimes@msmmeng.com',                   'Engineering',         'Part Time Hourly',  'New Orleans', 'User'),
  ('sbobeck',    'Steve',     'Bobeck',    'Steve',     'Steve',     'sbobeck@msmmeng.com',                   'Engineering',         'Part Time Hourly',  'New Orleans', 'User'),
  ('djones',     'David',     'Jones',     'David',     'David J.',  'DJones@msmmeng.com',                    'Engineering',         'Part Time Hourly',  'New Orleans', 'User'),
  ('dsmith',     'Dominque',  'Smith',     'Dominque',  'Dominque',  'dsmith@msmmeng.com',                    'Project Management',  'Full Time Salary',  'New Orleans', 'User'),
  ('mharden',    'Mike',      'Harden',    'Mike',      'Mike',      'mrhardenllc@bellsouth.net',             'Project Management',  'Part Time Hourly',  'New Orleans', 'User'),
  ('lwalker',    'Lee',       'Walker',    'Lee',       'Lee',       'lee.walker@fieldsec.com',               'Project Management',  'Part Time Hourly',  'New Orleans', 'User'),
  ('cbrannon',   'Chuck',     'Brannon',   'Brannon',   'Chuck',     'charles.brannon@b2controlsolutions.com','Project Management',  'Part Time Hourly',  'New Orleans', 'User'),
  ('sleonard',   'Stephen',   'Leonard',   'Stephen',   'Stephen',   'SLeonard@msmmeng.com',                  'Engineering',         'Part Time Hourly',  'New Orleans', 'User')
on conflict (lower(email)) do nothing;

--------------------------------------------------------------------------------
-- Clients — name+district uniqueness; org_type lives here, not on projects.
--------------------------------------------------------------------------------
create table if not exists beacon_v2.clients (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  district       text,
  org_type       beacon_v2.org_type_enum,
  contact_person text,
  email          text,
  phone          text,
  address        text,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index if not exists clients_name_district_uniq
  on beacon_v2.clients (name, coalesce(district, ''));

drop trigger if exists touch_clients on beacon_v2.clients;
create trigger touch_clients before update on beacon_v2.clients
  for each row execute function beacon_v2.touch_updated_at();

--------------------------------------------------------------------------------
-- Companies — singleton MSMM row enforced by partial unique index.
--------------------------------------------------------------------------------
create table if not exists beacon_v2.companies (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique,
  is_msmm        boolean not null default false,
  contact_person text,
  email          text,
  phone          text,
  address        text,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index if not exists companies_single_msmm
  on beacon_v2.companies ((1)) where is_msmm;

drop trigger if exists touch_companies on beacon_v2.companies;
create trigger touch_companies before update on beacon_v2.companies
  for each row execute function beacon_v2.touch_updated_at();

insert into beacon_v2.companies (name, is_msmm) values ('MSMM', true)
on conflict (name) do nothing;
