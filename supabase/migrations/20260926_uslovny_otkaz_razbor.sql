create extension if not exists pg_net;

-- Выгрузка воронки «Условный отказ» для разбора. Временная: после разбора очищается.
-- Без имён и телефонов клиентов: номер сделки, этапы, звонки, заметки с замазанными номерами.
create table if not exists public.uo_razbor (
  lead_id bigint primary key,
  data jsonb not null,
  loaded_at timestamptz not null default now()
);

-- Журнал запусков выгрузки.
create table if not exists public.uo_zapuski (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'идёт',
  info jsonb
);

alter table public.uo_razbor enable row level security;
alter table public.uo_zapuski enable row level security;
