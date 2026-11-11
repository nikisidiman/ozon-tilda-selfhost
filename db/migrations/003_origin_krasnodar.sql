-- Краснодар — второй готовый город отгрузки. Метод доставки заводится сам (см. 002).
insert into origins (code, city, shipment_method_id, sort)
values ('krd', 'Краснодар', 0, 5)
on conflict (code) do nothing;
update shops set origin_code = 'krd' where origin_code is null;
