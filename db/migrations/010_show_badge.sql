-- «Иконка Озон»: показывать ли значок Ozon после названия варианта доставки в корзине.
alter table shops add column if not exists show_badge boolean not null default true;
