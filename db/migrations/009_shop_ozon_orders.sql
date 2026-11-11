-- Отправка заказов Tilda в кабинет Ozon Доставки магазина (server/src/ozon/orders.ts).
alter table shops add column if not exists ozon_orders_enabled boolean not null default false;
-- Корзина шлёт данные только после оплаты — отправление сразу подтверждаем (approve).
alter table shops add column if not exists ozon_orders_approve boolean not null default false;
-- Секрет в адресе вебхука Tilda: публичный ключ магазина виден в коде сайта, им заказы не принимаем.
alter table shops add column if not exists hook_token text unique;

-- Заказы, пришедшие вебхуком. Уникальность (магазин, заказ Tilda) — защита от второго
-- отправления при повторе вебхука: order/create у Ozon не идемпотентен.
create table if not exists shop_orders (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references shops(id) on delete cascade,
  tilda_order_id  text not null,
  pvz_id          bigint,
  goods_kop       bigint,
  dims            jsonb,             -- {length_mm, width_mm, height_mm, weight_g, source: items|shop}
  -- creating → created → approved; failed — Ozon отказал; unknown — ответа нет, отправление могло создаться.
  status          text not null default 'creating',
  posting_number  text,
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (shop_id, tilda_order_id)
);
create index if not exists shop_orders_recent on shop_orders (shop_id, created_at desc);
