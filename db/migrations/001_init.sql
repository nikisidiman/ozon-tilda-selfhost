-- Ozon доставка для Tilda — начальная схема.
-- Персональных данных покупателей здесь нет и не должно быть: см. docs/SPEC.md.

create extension if not exists pgcrypto;

-- Ключ города: Tilda отдаёт город то кириллицей, то латиницей («Krasnodar»),
-- поэтому сравниваем транслит без разделителей. Алгоритм
-- живёт только здесь, чтобы не разъехаться с колонкой pvz.city_key.
create or replace function city_key(src text)
returns text language sql immutable strict parallel safe as $$
  select regexp_replace(
    translate(
      replace(replace(replace(replace(replace(replace(replace(
        lower(src),
        'ж', 'zh'), 'ч', 'ch'), 'ш', 'sh'), 'щ', 'sch'),
        'ю', 'yu'), 'я', 'ya'), 'ё', 'e'),
      'абвгдезийклмнопрстуфхцыэъь',
      'abvgdeziyklmnoprstufhcye'
    ),
    '[^a-z0-9]', '', 'g'
  )
$$;

create table users (
  id               uuid primary key default gen_random_uuid(),
  email            text not null unique,          -- нижний регистр
  name             text,
  password_hash    text not null,                  -- scrypt$N$r$p$salt$hash
  terms_version    text not null,
  consent_version  text not null,
  consent_at       timestamptz not null,
  created_at       timestamptz not null default now()
);

create table sessions (
  token_hash   text primary key,
  user_id      uuid not null references users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null
);
create index sessions_user_idx on sessions(user_id);

create table password_resets (
  token_hash   text primary key,
  user_id      uuid not null references users(id) on delete cascade,
  expires_at   timestamptz not null,
  used_at      timestamptz
);

create table login_failures (
  email        text not null,
  at           timestamptz not null default now()
);
create index login_failures_idx on login_failures(email, at);

-- Города отгрузки = методы доставки в аккаунте Ozon владельца сервиса.
create table origins (
  code                text primary key,              -- 'msk'
  city                text not null,                 -- 'Москва'
  shipment_method_id  bigint not null,
  active              boolean not null default true,
  sort                int not null default 100
);

create table shops (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null unique references users(id) on delete cascade,
  public_key          text not null unique,          -- sh_xxxxxxxxxx, виден в HEAD сайта
  origin_code         text references origins(code),
  box_l_cm            int not null default 30 check (box_l_cm between 1 and 200),
  box_w_cm            int not null default 20 check (box_w_cm between 1 and 200),
  box_h_cm            int not null default 10 check (box_h_cm between 1 and 200),
  markup_pct          numeric(5,2) not null default 0 check (markup_pct between 0 and 300),
  free_from_rub       int check (free_from_rub is null or free_from_rub >= 0),
  insurance_in_price  boolean not null default true,
  fallback_rub        int not null default 350 check (fallback_rub between 0 and 100000),
  onboarded_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table shop_domains (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references shops(id) on delete cascade,
  domain        text not null,                       -- без схемы и www, нижний регистр
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (shop_id, domain)
);

-- Домен, с которого пришёл виджет с ключом магазина, но которого нет в списке.
create table shop_origin_attempts (
  shop_id     uuid not null references shops(id) on delete cascade,
  domain      text not null,
  last_at     timestamptz not null default now(),
  hits        int not null default 1,
  primary key (shop_id, domain)
);

create table pvz (
  id             bigint primary key,                 -- map_point_id / delivery_point_id Ozon
  city           text not null,
  city_key       text generated always as (city_key(city)) stored,
  region         text,
  name           text not null,
  address        text not null,
  working_hours  text,
  lat            double precision,
  lon            double precision,
  enabled        boolean not null default true,
  synced_at      timestamptz not null default now()
);
create index pvz_city_idx on pvz(city_key) where enabled;

create table quote_cache (
  origin_code   text not null,
  pvz_id        bigint not null,
  box_key       text not null,                       -- '300x200x100' мм
  delivery_kop  int,                                 -- null — Ozon отказал (error_code)
  days          int,
  error_code    text,
  fetched_at    timestamptz not null default now(),
  primary key (origin_code, pvz_id, box_key)
);

create table stats_daily (
  shop_id    uuid not null references shops(id) on delete cascade,
  day        date not null,
  city_key   text not null,
  city       text not null,
  quotes     int not null default 0,
  sum_rub    bigint not null default 0,              -- сумма цен для покупателя, для средней
  primary key (shop_id, day, city_key)
);

create table rate_hits (
  bucket      text not null,
  window_end  timestamptz not null,
  hits        int not null default 0,
  primary key (bucket, window_end)
);
