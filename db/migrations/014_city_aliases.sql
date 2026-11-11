-- Город из корзины Tilda на любом языке находит ПВЗ Ozon.
--
-- Покупатель с английским браузером выбирает «Москва», а Tilda кладёт в поле
-- tildadelivery-city «Moscow». city_key — транслит, «moscow» ≠ «moskva»: /pvz отвечал
-- пустым списком. Подсказка «напишите по-русски» не помогает — Tilda подставляет название
-- из своего справочника (geoserv, языков два: ru и en).
--
-- Проверено 08.11.2026 на 300 крупнейших городах реестра с lang=en: у 298 английское
-- название — транслит, совпадающий с city_key. Не сходятся Moscow и Saint Petersburg —
-- исторические названия, транслитом не получить. Крыма в справочнике Tilda нет вовсе.
--
-- Решение:
--   1. Словарь синонимов city_aliases: Moscow → Москва и т. п. Пополняется строкой.
--   2. Мягкий ключ city_fold поверх city_key: склеивает варианты транслита
--      (Yekaterinburg = Ekaterinburg, Nizhny = Nizhniy). На случай, если Tilda поменяет
--      правила транслита или город придёт не из её справочника.
-- city_key и pvz.city_key остаются как были.

-- Мягкий ключ. Правила подобраны по реестру (95 803 точки): каждое не склеивает разные
-- города. Отвергнуты «i перед гласной выпадает» (Юрга = Урга), «двойные → одна» (Абдулино =
-- Абдуллино), «ts → c» (Шатск = Шацк).
create or replace function city_fold(src text)
returns text language sql immutable strict parallel safe as $$
  select replace(                                -- ё: yo → e
    regexp_replace(                              -- е в начале и после гласной: ye → e
      regexp_replace(                            -- ий/ый: iy, yy → y (Nizhniy = Nizhny)
        translate(                               -- j → y, w → v
          replace(replace(replace(
            city_key(src),
            'shch', 'sch'),                      -- щ: shch / sch
            'kh', 'h'),                          -- х: kh / h
            'x', 'ks'),                          -- кс: x
          'jw', 'yv'),
        '(iy|yy)', 'y', 'g'),
      '(^|[aeiouy])ye', '\1e', 'g'),
    'yo', 'e')
$$;

alter table pvz add column if not exists city_fold text generated always as (city_fold(city)) stored;
create index if not exists pvz_city_fold_idx on pvz (city_fold) where enabled;

-- Синонимы: названия, которые транслитом из реестра не получить.
create table if not exists city_aliases (
  alias      text primary key,                                   -- как город может прийти из корзины
  city       text not null,                                      -- как он записан в pvz.city
  alias_fold text generated always as (city_fold(alias)) stored,
  city_fold  text generated always as (city_fold(city)) stored,
  note       text
);
create unique index if not exists city_aliases_alias_fold_uidx on city_aliases (alias_fold);

insert into city_aliases (alias, city, note) values
  ('Moscow',           'Москва',          'Tilda, lang=en'),
  ('Moskau',           'Москва',          'немецкое'),
  ('Moscou',           'Москва',          'французское'),
  ('Mosca',            'Москва',          'итальянское'),
  ('Мск',              'Москва',          'сокращение'),
  ('Saint Petersburg', 'Санкт-Петербург', 'Tilda, lang=en'),
  ('St Petersburg',    'Санкт-Петербург', 'сокращение'),
  ('Sankt Petersburg', 'Санкт-Петербург', 'немецкое'),
  ('Petersburg',       'Санкт-Петербург', 'сокращение'),
  ('СПб',              'Санкт-Петербург', 'сокращение'),
  ('Питер',            'Санкт-Петербург', 'разговорное'),
  ('Rostov-on-Don',    'Ростов-на-Дону',  'английское'),
  ('Togliatti',        'Тольятти',        'английское')
on conflict (alias) do nothing;

-- Ключ города из корзины для сравнения с pvz.city_fold: сначала синоним, иначе мягкий ключ.
-- stable, а не immutable: читает city_aliases.
create or replace function city_match(src text)
returns text language sql stable strict parallel safe as $$
  select coalesce((select a.city_fold from city_aliases a where a.alias_fold = city_fold(src)), city_fold(src))
$$;

-- Без статистики по новой колонке планировщик ждёт для Москвы сотни строк вместо тысяч.
analyze pvz;
