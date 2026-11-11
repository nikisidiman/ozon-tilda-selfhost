-- Журнал согласий: кто, на что, когда и под какой версией текста дал или отозвал согласие.
-- kind: terms (оферта) | personal_data (обработка ПДн) | marketing (реклама и новости, ст. 18 38-ФЗ).
-- source: register | profile. IP — усечённый, как в логах.
create table if not exists consent_events (
  id           bigserial primary key,
  user_id      uuid not null references users(id) on delete cascade,
  kind         text not null check (kind in ('terms', 'personal_data', 'marketing')),
  granted      boolean not null,
  doc_version  text not null,
  source       text not null,
  ip           text,
  created_at   timestamptz not null default now()
);
create index if not exists consent_events_user_idx on consent_events(user_id, kind, created_at desc);

-- Текущее состояние согласия на рассылки — для выборки получателей: select email from users where marketing_consent.
alter table users add column if not exists marketing_consent boolean not null default false;
alter table users add column if not exists marketing_consent_at timestamptz;

-- Обязательные согласия уже зарегистрированных — в журнал из полей users.
insert into consent_events (user_id, kind, granted, doc_version, source, created_at)
  select id, 'terms', true, terms_version, 'register', consent_at from users
  union all
  select id, 'personal_data', true, consent_version, 'register', consent_at from users;
