-- Необязательные ключи Ozon Доставки магазина (server/src/ozon/shop-keys.ts).
-- Секрет — только зашифрованный; номера покупателей — только HMAC.
alter table shops add column if not exists ozon_client_id text;
alter table shops add column if not exists ozon_secret_enc text;
alter table shops add column if not exists ozon_phone text;               -- контакт магазина для метода доставки
alter table shops add column if not exists ozon_keys_status text;         -- ok | error | broken
alter table shops add column if not exists ozon_keys_check jsonb;         -- результат последней проверки по шагам
alter table shops add column if not exists ozon_keys_checked_at timestamptz;
alter table shops add column if not exists policy_url text;               -- политика магазина: ссылка под проверкой номера

-- Метод доставки в аккаунте Ozon магазина — на каждый город отгрузки.
create table if not exists shop_shipment_methods (
  shop_id             uuid not null references shops(id) on delete cascade,
  origin_code         text not null references origins(code),
  shipment_method_id  bigint not null,
  dropoff_address     text,
  created_at          timestamptz not null default now(),
  primary key (shop_id, origin_code)
);

-- Цены по договору магазина отличаются от цен сервиса: кеш — по аккаунту ('svc' или id магазина).
alter table quote_cache add column if not exists account text not null default 'svc';
alter table quote_cache drop constraint if exists quote_cache_pkey;
alter table quote_cache add primary key (account, origin_code, pvz_id, box_key);

-- Проверка «есть ли у номера аккаунт Ozon». Открытого номера нет — только HMAC.
create table if not exists phone_checks (
  account           text not null,
  phone_hash        text not null,
  can_be_delivered  boolean not null,
  checked_at        timestamptz not null default now(),
  primary key (account, phone_hash)
);
