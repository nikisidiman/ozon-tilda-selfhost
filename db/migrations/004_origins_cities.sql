-- Города отгрузки: метод доставки Ozon создаётся автоматически при первом выборе города
-- (server/src/ozon/origins.ts). Координаты — центр города, для поиска пункта отгрузки.
alter table origins alter column shipment_method_id drop not null;
alter table origins add column if not exists lat double precision;
alter table origins add column if not exists lon double precision;
alter table origins add column if not exists dropoff_address text;

update origins set shipment_method_id = null, lat = 45.0355, lon = 38.9753 where code = 'krd';
update origins set active = true, shipment_method_id = null, lat = 55.7558, lon = 37.6176 where code = 'msk';

insert into origins (code, city, shipment_method_id, lat, lon, sort) values
  ('spb', 'Санкт-Петербург', null, 59.9343, 30.3351, 20),
  ('kzn', 'Казань', null, 55.7961, 49.1064, 30),
  ('ekb', 'Екатеринбург', null, 56.8389, 60.6057, 40),
  ('nsk', 'Новосибирск', null, 55.0084, 82.9357, 50),
  ('nnv', 'Нижний Новгород', null, 56.3269, 44.0059, 60),
  ('rnd', 'Ростов-на-Дону', null, 47.2357, 39.7015, 70),
  ('sam', 'Самара', null, 53.1959, 50.1002, 80),
  ('chl', 'Челябинск', null, 55.1644, 61.4368, 90),
  ('ufa', 'Уфа', null, 54.7388, 55.9721, 100),
  ('vrn', 'Воронеж', null, 51.6720, 39.1843, 110),
  ('prm', 'Пермь', null, 58.0105, 56.2502, 120),
  ('vlg', 'Волгоград', null, 48.7080, 44.5133, 130),
  ('krs', 'Красноярск', null, 56.0153, 92.8932, 140),
  ('oms', 'Омск', null, 54.9885, 73.3242, 150),
  ('tmn', 'Тюмень', null, 57.1530, 65.5343, 160),
  ('irk', 'Иркутск', null, 52.2870, 104.3050, 170),
  ('vvo', 'Владивосток', null, 43.1155, 131.8855, 180),
  ('khv', 'Хабаровск', null, 48.4802, 135.0719, 190),
  ('sch', 'Сочи', null, 43.5855, 39.7231, 200)
on conflict (code) do nothing;

update origins set sort = 10 where code = 'msk';
update origins set sort = 25 where code = 'krd';
