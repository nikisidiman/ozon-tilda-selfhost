// Настройки единственного магазина. Пишет их команда ozon-tilda setup (server/src/cli/setup.ts).
// Магазин один, но схема базы осталась от многопользовательской версии: у shops есть
// обязательный владелец users — заводим служебного, войти под ним нельзя.

import { randomBytes } from 'node:crypto'
import { one, q } from './db.js'
import { config } from './config.js'
import { newShopKey, normalizeDomain } from './lib/security.js'
import { boxOf, customerPrice } from './lib/price.js'
import { quotePvz, type PvzQuote } from './ozon/quote.js'
import { ensureShipmentMethod } from './ozon/origins.js'
import { encryptSecret, SERVICE_ACCOUNT, shopAccount, type OzonAccount } from './ozon/shop-keys.js'
import { verifyShopKeys, type KeyStep } from './ozon/verify-keys.js'

const OWNER_EMAIL = 'owner@localhost'

export interface Shop {
  id: string; public_key: string; origin_code: string | null; box_l_cm: number; box_w_cm: number; box_h_cm: number; box_weight_g: number
  markup_pct: string; free_from_rub: number | null; insurance_in_price: boolean
  ozon_client_id: string | null; ozon_secret_enc: string | null; ozon_phone: string | null; ozon_keys_status: string | null
  ozon_keys_check: KeyStep[] | null
  ozon_orders_enabled: boolean; ozon_orders_approve: boolean; hook_token: string | null; show_badge: boolean
  onboarded_at: Date | null; wizard: Record<string, string>
}

const SHOP_COLUMNS = `id, public_key, origin_code, box_l_cm, box_w_cm, box_h_cm, box_weight_g, markup_pct, free_from_rub, insurance_in_price,
  ozon_client_id, ozon_secret_enc, ozon_phone, ozon_keys_status, ozon_keys_check,
  ozon_orders_enabled, ozon_orders_approve, hook_token, show_badge, onboarded_at, wizard`

export async function getShop(): Promise<Shop | null> {
  return one<Shop>(`select ${SHOP_COLUMNS} from shops order by created_at limit 1`)
}

/** Магазин есть всегда после первого запуска setup. */
export async function ensureShop(): Promise<Shop> {
  const s = await getShop()
  if (s) return s
  const u = await one<{ id: string }>(
    `insert into users (email, password_hash, terms_version, consent_version, consent_at)
     values ($1, 'disabled', 'single-shop', 'single-shop', now())
     on conflict (email) do update set email = excluded.email returning id`, [OWNER_EMAIL])
  await q('insert into shops (user_id, public_key) values ($1, $2) on conflict (user_id) do nothing', [u!.id, newShopKey()])
  return (await getShop())!
}

// —— Ключи Ozon ——

/** Записать ключи магазина и проверить их по шагам. Ключи те же, что в .env (OZON_DELIVERY_*). */
export async function saveKeys(s: Shop, clientId: string, secret: string, phone: string): Promise<KeyStep[]> {
  const secretEnc = encryptSecret(secret)
  // Новые ключи — новый аккаунт Ozon: старые методы доставки и кеши к нему не относятся.
  if (clientId !== s.ozon_client_id) await forgetShopOzon(s.id)
  await q(`update shops set ozon_client_id=$1, ozon_secret_enc=$2, ozon_phone=$3, updated_at=now() where id=$4`,
    [clientId, secretEnc, phone, s.id])
  return recheckKeys((await getShop())!)
}

export async function recheckKeys(s: Shop): Promise<KeyStep[]> {
  const acc = accountOfShop(s)
  if (!acc || !s.origin_code) return []
  const steps = await verifyShopKeys(acc, s.origin_code)
  const status = steps.every((x) => x.ok) ? 'ok' : 'error'
  await q(`update shops set ozon_keys_status=$1, ozon_keys_check=$2, ozon_keys_checked_at=now(), updated_at=now() where id=$3`,
    [status, JSON.stringify(steps), s.id])
  return steps
}

/** Аккаунт Ozon магазина без оглядки на статус проверки — чтобы её и провести. */
export function accountOfShop(s: Shop): OzonAccount | null {
  return shopAccount({ ...s, ozon_keys_status: null })
}

async function forgetShopOzon(shopId: string) {
  await q('delete from shop_shipment_methods where shop_id = $1', [shopId])
  await q('delete from quote_cache where account = $1', [shopId])
  await q('delete from phone_checks where account = $1', [shopId])
}

// —— Домены ——

export async function getDomains(shopId: string): Promise<{ domain: string; last_seen_at: Date | null; widget_mode: string | null; widget_issue: string | null }[]> {
  return q('select domain, last_seen_at, widget_mode, widget_issue from shop_domains where shop_id = $1 order by created_at', [shopId])
}

/** Разобрать «shop.ru, www.shop.ru». null — какой-то домен не разобрался. */
export function parseDomains(raw: string): string[] | null {
  const parts = raw.split(/[\s,;]+/).filter(Boolean)
  const out: string[] = []
  for (const p of parts) {
    const d = normalizeDomain(p)
    if (!d) return null
    if (!out.includes(d)) out.push(d)
  }
  return out.length ? out : null
}

export async function saveDomains(shopId: string, domains: string[]): Promise<void> {
  await q('delete from shop_domains where shop_id = $1 and not (domain = any($2))', [shopId, domains])
  for (const d of domains) await q('insert into shop_domains (shop_id, domain) values ($1, $2) on conflict do nothing', [shopId, d])
}

// —— Город отгрузки ——

export interface Origin { code: string; city: string }

export async function listOrigins(): Promise<Origin[]> {
  return q<Origin>(`select code, city from origins where active and code not like 'x\\_%' order by sort, city`)
}

export async function originByCode(code: string | null): Promise<Origin | null> {
  return code ? one<Origin>('select code, city from origins where code = $1', [code]) : null
}

export interface CityMatch { city: string; points: number; sample: string }

/** Города из справочника пунктов Ozon по началу названия (кириллица или латиница). */
export async function searchCities(term: string): Promise<CityMatch[]> {
  const t = term.trim().slice(0, 60)
  if (t.length < 2) return []
  const like = `${t.replace(/[%_\\]/g, (m) => '\\' + m)}%`
  const rows = await q<{ city: string; n: string; sample: string }>(
    `select city, count(*) n, min(address) sample from pvz
      where enabled and (city ilike $1 or city_fold like city_fold($2) || '%' or city_fold = city_match($2))
      group by city order by count(*) desc limit 10`, [like, t])
  return rows.map((r) => ({ city: r.city, points: Number(r.n), sample: r.sample }))
}

/** Город отгрузки по названию из справочника. Нет среди готовых — заводим, центр — среднее по пунктам города. */
export async function originForCity(city: string): Promise<Origin> {
  const known = await one<Origin>('select code, city from origins where city_key(city) = city_key($1) order by sort limit 1', [city])
  if (known) {
    // Город, заведённый в тестовом режиме, остался без координат — берём их из настоящего справочника.
    await q(`update origins o set active = true,
               lat = coalesce(o.lat, (select avg(lat) from pvz where enabled and city_key = city_key(o.city))),
               lon = coalesce(o.lon, (select avg(lon) from pvz where enabled and city_key = city_key(o.city)))
             where code = $1`, [known.code])
    return known
  }
  const c = await one<{ key: string; lat: number | null; lon: number | null }>(
    `select city_key($1) as key, avg(lat) as lat, avg(lon) as lon from pvz where enabled and city_key = city_key($1)`, [city])
  const code = `x_${c!.key}`.slice(0, 60)
  await q(`insert into origins (code, city, lat, lon, sort) values ($1, $2, $3, $4, 1000)
           on conflict (code) do update set city = excluded.city, lat = excluded.lat, lon = excluded.lon, active = true`,
    [code, city, c!.lat, c!.lon])
  return { code, city }
}

/** Метод доставки Ozon для города: создаётся в аккаунте магазина при первом обращении. */
export async function prepareOrigin(s: Shop): Promise<number | null> {
  const acc = accountOfShop(s)
  if (!s.origin_code || !acc) return null
  return ensureShipmentMethod(s.origin_code, acc)
}

// —— Цена, значок, заказы ——

export async function saveOrigin(shopId: string, originCode: string): Promise<void> {
  await q('update shops set origin_code=$1, updated_at=now() where id=$2', [originCode, shopId])
}

export interface Pricing { box: { l: number; w: number; h: number }; weightG: number; markupPct: number; freeFromRub: number | null; showBadge: boolean }

/** Шаг 5 мастера. onboarded_at — признак, что цена хоть раз настроена (ozon-tilda setup, обзор). */
export async function savePricing(shopId: string, p: Pricing): Promise<void> {
  await q(`update shops set box_l_cm=$1, box_w_cm=$2, box_h_cm=$3, markup_pct=$4, free_from_rub=$5,
                show_badge=$6, box_weight_g=$7, onboarded_at=coalesce(onboarded_at, now()), updated_at=now() where id=$8`,
    [p.box.l, p.box.w, p.box.h, p.markupPct, p.freeFromRub, p.showBadge, p.weightG, shopId])
}

/** Отметка мастера: клиент сделал действие в Tilda (head, delivery, hook, badge, publish). */
export async function markDone(shopId: string, key: string): Promise<void> {
  await q(`update shops set wizard = wizard || jsonb_build_object($1::text, now()), updated_at=now() where id=$2`, [key, shopId])
}

/** Есть ли код виджета на опубликованном сайте: ok — есть, missing — нет, error — сайт не открылся. */
export async function siteHasCode(domain: string, publicKey: string): Promise<'ok' | 'missing' | 'error'> {
  try {
    const r = await fetch(`https://${domain}/`, { signal: AbortSignal.timeout(10_000), redirect: 'follow' })
    const html = await r.text()
    return html.includes(publicKey) && html.includes('/w.js') ? 'ok' : 'missing'
  } catch {
    return 'error'
  }
}

/** Пришёл ли от Tilda хоть один вебхук после момента since (проверочный при добавлении). */
export async function hookSince(shopId: string, since: Date): Promise<boolean> {
  return !!(await one('select 1 from hook_log where shop_id = $1 and at >= $2 limit 1', [shopId, since]))
}

export async function saveBadge(shopId: string, show: boolean): Promise<void> {
  await q('update shops set show_badge=$1, updated_at=now() where id=$2', [show, shopId])
}

/** Включить или выключить отправку заказов в Ozon. Адрес вебхука заводится при первом включении. */
export async function saveOrders(shopId: string, enabled: boolean, approve: boolean): Promise<void> {
  await q(`update shops set ozon_orders_enabled=$1, ozon_orders_approve=$2,
                hook_token = coalesce(hook_token, $3), updated_at=now() where id=$4`,
    [enabled, enabled && approve, randomBytes(18).toString('base64url'), shopId])
}

export function snippet(s: Shop): string {
  return `<script src="${config.publicUrl}/w.js" data-shop="${s.public_key}" async></script>`
}

export function hookUrl(s: Shop): string | null {
  return s.hook_token ? `${config.publicUrl}/api/hook/tilda/${s.hook_token}` : null
}

// —— Пробный расчёт ——

export interface TrialQuote { from: string; to: string; point: string; quote: PvzQuote; priceRub: number | null }

/** Посчитать доставку до одного пункта в другом крупном городе — как это сделает корзина. */
export async function trialQuote(s: Shop): Promise<TrialQuote | null> {
  const origin = await originByCode(s.origin_code)
  // Без ключей в базе (тестовый режим) — считаем как сервис.
  const acc = accountOfShop(s) ?? SERVICE_ACCOUNT
  if (!origin) return null
  const target = await one<{ id: string; city: string; address: string }>(
    `select id::text, city, address from pvz where enabled and city_key <> city_key($1)
       and city_key in (city_key('Москва'), city_key('Новосибирск'), city_key('Санкт-Петербург'))
     order by case city_key when city_key('Новосибирск') then 0 when city_key('Москва') then 1 else 2 end, id limit 1`, [origin.city])
  if (!target) return null
  const methodId = await ensureShipmentMethod(origin.code, acc)
  const box = boxOf(s.box_l_cm, s.box_w_cm, s.box_h_cm, s.box_weight_g)
  const quote = await quotePvz({ account: acc, originCode: origin.code, shipmentMethodId: methodId ?? 0, pvzId: Number(target.id), box },
    async () => methodId === null)
  const priceRub = quote.ok
    ? customerPrice(quote.deliveryKop, 0, { markupPct: Number(s.markup_pct), freeFromRub: null, insuranceInPrice: s.insurance_in_price }).priceRub
    : null
  return { from: origin.city, to: target.city, point: target.address, quote, priceRub }
}

export interface OrderDims { length_mm: number; width_mm: number; height_mm: number; weight_g: number; source: 'items' | 'shop' }
export interface OrderRow { tilda_order_id: string; status: string; posting_number: string | null; error: string | null; created_at: Date; dims: OrderDims | null }

export async function recentOrders(shopId: string, limit = 20): Promise<OrderRow[]> {
  return q<OrderRow>(`select tilda_order_id, status, posting_number, error, created_at, dims
                        from shop_orders where shop_id = $1 order by created_at desc limit $2`, [shopId, limit])
}

// —— Журнал вебхуков (routes/hook.ts) ——

export interface HookRow { id: string; at: Date; result: string; tilda_order_id: string | null; order_status: string | null; body?: unknown }

/** Последние вебхуки, включая пришедшие на неверный адрес (shop_id null). */
export async function recentHooks(limit = 30): Promise<HookRow[]> {
  return q<HookRow>(`select h.id::text, h.at, h.result, h.tilda_order_id, o.status as order_status
                       from hook_log h left join shop_orders o on o.shop_id = h.shop_id and o.tilda_order_id = h.tilda_order_id
                      order by h.at desc limit $1`, [limit])
}

/** Вебхуки по номеру заказа Tilda или по номеру записи журнала. */
export async function hookDetails(ref: string): Promise<HookRow[]> {
  const byOrder = await q<HookRow>(`select id::text, at, result, tilda_order_id, null as order_status, body
                                      from hook_log where tilda_order_id = $1 order by at`, [ref])
  if (byOrder.length || !/^\d{1,18}$/.test(ref)) return byOrder
  return q<HookRow>(`select id::text, at, result, tilda_order_id, null as order_status, body from hook_log where id = $1`, [ref])
}
