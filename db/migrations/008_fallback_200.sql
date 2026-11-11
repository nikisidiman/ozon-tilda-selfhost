-- Резервная цена больше не настраивается в кабинете: одна на всех — 200 ₽ (FALLBACK_RUB в web/cabinet/src/ui.tsx).
alter table shops alter column fallback_rub set default 200;
update shops set fallback_rub = 200 where fallback_rub <> 200;
