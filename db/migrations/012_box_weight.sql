-- Вес средней посылки: им считается цена в корзине и он уходит в Ozon, если у товаров
-- в Tilda не заполнены габариты или вес (ozon-tilda setup, шаг 5).
alter table shops add column if not exists box_weight_g integer not null default 500;
