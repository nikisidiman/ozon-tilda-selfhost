-- Город отгрузки по умолчанию: Москва. Метод доставки Ozon заводится сам при первом выборе
-- города (server/src/ozon/origins.ts); 0 — заглушка до 004, где колонка становится необязательной.
insert into origins (code, city, shipment_method_id, sort)
values ('msk', 'Москва', 0, 10)
on conflict (code) do nothing;
