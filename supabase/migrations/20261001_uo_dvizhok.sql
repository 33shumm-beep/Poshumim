-- Тексты возврата: причина отказа × номер касания. Отправляются только со статусом «согласован».
create table if not exists public.uo_teksty (
  prichina text not null, kasanie int not null, cherez_dney int not null,
  tekst text not null, status text not null default 'черновик', soglasovan_at timestamptz,
  primary key (prichina, kasanie)
);
alter table public.uo_teksty enable row level security;

-- Условия компании, которые можно обещать в текстах.
create table if not exists public.uo_usloviya (k text primary key, v text not null);
alter table public.uo_usloviya enable row level security;

-- Служебный ключ, которым движок проверяет, что вызов пришёл из своей базы.
create table if not exists public.sluzhebnoe (k text primary key, v text not null);
alter table public.sluzhebnoe enable row level security;
insert into public.sluzhebnoe(k, v) values ('ключ_функций', encode(gen_random_bytes(24), 'hex')) on conflict (k) do nothing;

create extension if not exists pg_cron;

create table if not exists public.uo_sostoyanie (
  lead_id bigint primary key, prichina text not null, segment text not null,
  kasanie int not null default 0, sleduyushee_at timestamptz not null default now(),
  status text not null default 'идёт', obnovleno_at timestamptz not null default now()
);
alter table public.uo_sostoyanie enable row level security;

create table if not exists public.uo_zhurnal (
  id bigserial primary key, at timestamptz not null default now(),
  lead_id bigint, deystvie text not null, info jsonb
);
alter table public.uo_zhurnal enable row level security;

create table if not exists public.uo_nastroyki (k text primary key, v text);
alter table public.uo_nastroyki enable row level security;
insert into public.uo_nastroyki(k, v) values
  ('bot_id', null), ('limit_v_den', '50'), ('vklyucheno', 'нет'),
  ('isklyuchit_otvetstvennyh', 'Макридин'),
  ('poslednyaya_proverka_otvetov', extract(epoch from now())::bigint::text)
on conflict (k) do nothing;

-- Вызов движка из базы; срабатывает, только если vklyucheno = 'да'.
-- Anon-ключ в заголовке Authorization подставляется при применении (get_publishable_keys).
create or replace function public.uo_vyzov(deystvie text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce((select v from uo_nastroyki where k = 'vklyucheno'), 'нет') <> 'да' then return; end if;
  perform net.http_post(
    url := 'https://dfcylgccovrzrlgfpfpw.supabase.co/functions/v1/uo-dvizhok',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer <anon-ключ>',
      'x-shumm-key', (select v from sluzhebnoe where k = 'ключ_функций')),
    body := jsonb_build_object('action', deystvie),
    timeout_milliseconds := 300000);
end $$;
revoke all on function public.uo_vyzov(text) from public, anon, authenticated;

select cron.schedule('uo-utro', '0 7 * * 1-6', $$select public.uo_vyzov('run')$$);
select cron.schedule('uo-otvety', '*/15 * * * *', $$select public.uo_vyzov('otvety')$$);
