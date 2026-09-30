-- Тексты возврата: причина отказа × номер касания. Отправляются только со статусом «согласован».
create table if not exists public.uo_teksty (
  prichina text not null,          -- dorogo | konkurenty | sam | ne_na_svyazi
  kasanie int not null,            -- 1, 2, 3
  cherez_dney int not null,        -- через сколько дней после предыдущего касания
  tekst text not null,
  status text not null default 'черновик',  -- черновик | согласован
  soglasovan_at timestamptz,
  primary key (prichina, kasanie)
);
alter table public.uo_teksty enable row level security;

-- Условия компании, которые можно обещать в текстах (со слов заказчика 26–29.09).
create table if not exists public.uo_usloviya (k text primary key, v text not null);
alter table public.uo_usloviya enable row level security;
insert into public.uo_usloviya(k, v) values
  ('подарок', '3D-визуализация и тёплый пол в санузле'),
  ('оплата', 'поэтапная, по ходу выполнения работ; рассрочки нет'),
  ('нельзя', 'удешевлять смету, менять или убирать позиции; смету уже разбирали с клиентом в офисе'),
  ('услуга', 'аудит смет')
on conflict (k) do update set v = excluded.v;
