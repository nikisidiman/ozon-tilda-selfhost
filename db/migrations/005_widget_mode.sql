-- Как настроена корзина на сайте магазина — сообщает виджет (GET /api/w/status).
-- mode: none | simple | advanced; issue: advanced_no_ozon (расширенная доставка без варианта Ozon).
alter table shop_domains add column if not exists widget_mode text;
alter table shop_domains add column if not exists widget_issue text;
alter table shop_domains add column if not exists mode_at timestamptz;
