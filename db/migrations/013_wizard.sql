-- Что клиент подтвердил в мастере ozon-tilda setup из действий в Tilda (код в HEAD, вариант
-- доставки, вебхук, публикация): {"head": "2026-11-03T…", …}. Только для обзора настроек.
alter table shops add column if not exists wizard jsonb not null default '{}'::jsonb;
