-- Журнал входящих вебхуков Tilda — разбирать, почему заказ не дошёл до Ozon (ozon-tilda logs).
-- Тело хранится с замаскированными данными покупателя (lib/tilda-order.ts maskPersonal), 30 дней.
create table if not exists hook_log (
  id              bigserial primary key,
  at              timestamptz not null default now(),
  shop_id         uuid references shops(id) on delete cascade,   -- null — адрес с неизвестным токеном
  -- accepted, unknown_token, test, disabled, busy, no_order, no_pvz
  result          text not null,
  tilda_order_id  text,
  body            jsonb
);
create index if not exists hook_log_recent on hook_log (at desc);
create index if not exists hook_log_order on hook_log (tilda_order_id);
