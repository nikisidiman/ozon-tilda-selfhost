// Публичный API виджета корзины. Вызывается браузером покупателя с сайта магазина.
// Принимает ключ магазина, город, строку поиска, ID пункта выдачи, сумму товаров.
// Номер телефона покупателя — только если магазин подключил свои ключи Ozon (POST
// /check-phone): обрабатываем по поручению магазина, храним лишь HMAC номера и ответ Ozon.
// Отвечает только доменам магазина (CORS).

import { Hono, type Context } from 'hono'
import { one, q } from '../db.js'
import { config } from '../config.js'
import { normalizeDomain, rateHit, sha256 } from '../lib/security.js'
import { boxOf, customerPrice } from '../lib/price.js'
import { quotePvz } from '../ozon/quote.js'
import { ensureShipmentMethod } from '../ozon/origins.js'
import { checkPhone } from '../ozon/check-client.js'
import { OzonAuthError } from '../ozon/client.js'
import { accountOf, markKeysBroken, normalizePhone, SERVICE_ACCOUNT, shopKeysEnabled, type OzonAccount } from '../ozon/shop-keys.js'
import { clientIp } from '../lib/http.js'

const MAX_INPUT = 120
const PER_IP_10MIN = 120
const PHONE_CHECKS_PER_HOUR = 300

interface ShopRow {
  id: string; origin_code: string | null; box_l_cm: number; box_w_cm: number; box_h_cm: number; box_weight_g: number
  markup_pct: string; free_from_rub: number | null; insurance_in_price: boolean; fallback_rub: number
  ozon_keys_status: string | null; show_badge: boolean
}

type Resolved = { shop: ShopRow; origin: string } | { error: Response }

function cors(c: Context, origin: string | null) {
  if (origin) {
    c.header('Access-Control-Allow-Origin', origin)
    c.header('Vary', 'Origin')
  }
  c.header('Cache-Control', 'no-store')
}

const MAX_DOMAINS = 20

async function resolveShop(c: Context): Promise<Resolved> {
  const key = (c.req.query('k') || '').slice(0, 40)
  const originHeader = c.req.header('origin') || null
  const shop = key ? await one<ShopRow>(
    `select id, origin_code, box_l_cm, box_w_cm, box_h_cm, box_weight_g, markup_pct, free_from_rub, insurance_in_price, fallback_rub,
            ozon_keys_status, show_badge
       from shops where public_key = $1`, [key]) : null
  if (!shop) return { error: c.json({ error: 'unknown_shop' }, 404) }

  const domain = originHeader ? normalizeDomain(originHeader) : null
  if (!domain) return { error: c.json({ error: 'no_origin' }, 403) }
  // Белого списка нет: домен сам попадает в «Сайты» при первом сигнале — так видно, где стоит виджет.
  // Больше MAX_DOMAINS в список не пишем (защита от мусора), но виджет работает и там — такие домены идут в попытки.
  const known = await one<{ id: string; last_seen_at: Date | null }>(
    'select id, last_seen_at from shop_domains where shop_id = $1 and domain = $2', [shop.id, domain])
  if (!known) {
    const added = await one<{ id: string }>(
      `insert into shop_domains (shop_id, domain, last_seen_at)
       select $1, $2, now() where (select count(*) from shop_domains where shop_id = $1) < $3
       on conflict (shop_id, domain) do nothing returning id`, [shop.id, domain, MAX_DOMAINS])
    if (!added) {
      await q(`insert into shop_origin_attempts (shop_id, domain) values ($1, $2)
               on conflict (shop_id, domain) do update set last_at = now(), hits = shop_origin_attempts.hits + 1`,
      [shop.id, domain])
    }
  } else if (!known.last_seen_at || Date.now() - known.last_seen_at.getTime() > 5 * 60_000) {
    await q('update shop_domains set last_seen_at = now() where id = $1', [known.id])
  }
  cors(c, originHeader)
  return { shop, origin: originHeader! }
}

async function limited(c: Context): Promise<boolean> {
  const hits = await rateHit(`w:${sha256(clientIp(c)).slice(0, 24)}`, 600)
  return hits > PER_IP_10MIN
}

export const widget = new Hono()

widget.get('/config', async (c) => {
  const r = await resolveShop(c)
  if ('error' in r) return r.error
  const s = r.shop
  return c.json({
    ready: !!s.origin_code,
    freeFromRub: s.free_from_rub,
    fallbackRub: s.fallback_rub,
    checkPhone: s.ozon_keys_status === 'ok' && shopKeysEnabled(),
    badge: s.show_badge,
  })
})

// Есть ли у номера покупателя аккаунт Ozon. Тело — text/plain с JSON {phone}: так запрос
// остаётся «простым» для CORS (без preflight), а номер не попадает в адрес и журналы.
widget.post('/check-phone', async (c) => {
  const r = await resolveShop(c)
  if ('error' in r) return r.error
  if (await limited(c)) return c.json({ canDeliver: null, reason: 'busy' }, 429)
  if (r.shop.ozon_keys_status !== 'ok' || !shopKeysEnabled()) return c.json({ canDeliver: null, reason: 'off' })
  let raw = ''
  try { raw = String((JSON.parse((await c.req.text()).slice(0, 500)) as { phone?: unknown }).phone ?? '') } catch { /* пусто */ }
  const phone = normalizePhone(raw)
  if (!phone) return c.json({ canDeliver: null, reason: 'bad_phone' })
  const acc = await accountOf(r.shop.id)
  if (!acc.creds) return c.json({ canDeliver: null, reason: 'off' })
  const res = await checkPhone(acc, phone, async () =>
    (await rateHit(`phone:${r.shop.id}`, 3600)) > PHONE_CHECKS_PER_HOUR || (await rateHit('global:ozon-miss', 3600)) > config.ozon.missesPerHour)
  if (!res.ok) {
    if (res.code === 'shop_keys') await markKeysBroken(r.shop.id)
    return c.json({ canDeliver: null, reason: 'unavailable' })
  }
  return c.json({ canDeliver: res.canDeliver })
})

// Какой режим корзины виджет нашёл на сайте — показывает ozon-tilda show.
widget.get('/status', async (c) => {
  const r = await resolveShop(c)
  if ('error' in r) return r.error
  const mode = ['none', 'simple', 'advanced'].includes(c.req.query('mode') || '') ? c.req.query('mode')! : null
  const issue = c.req.query('issue') === 'advanced_no_ozon' ? 'advanced_no_ozon' : null
  const domain = normalizeDomain(r.origin)
  await q(`update shop_domains set widget_mode = $1, widget_issue = $2, mode_at = now()
            where shop_id = $3 and domain = $4`, [mode, issue, r.shop.id, domain])
  return c.json({ ok: true })
})

// Подсказки города для режима «только скрипт» (в корзине нет поля «Город» Tilda).
widget.get('/cities', async (c) => {
  const r = await resolveShop(c)
  if ('error' in r) return r.error
  if (await limited(c)) return c.json({ error: 'busy' }, 429)
  const term = (c.req.query('q') || '').slice(0, 60).trim()
  if (term.length < 2) return c.json({ cities: [] })
  const like = `${term.replace(/[%_\\]/g, (m) => '\\' + m)}%`
  const rows = await q<{ city: string; n: string }>(
    `select city, count(*) n from pvz where enabled and (city ilike $1 or city_fold like city_fold($2) || '%' or city_fold = city_match($2))
      group by city order by count(*) desc limit 8`, [like, term])
  return c.json({ cities: rows.map((x) => ({ city: x.city, points: Number(x.n) })) })
})

widget.get('/pvz', async (c) => {
  const r = await resolveShop(c)
  if ('error' in r) return r.error
  if (await limited(c)) return c.json({ error: 'busy' }, 429)
  const city = (c.req.query('city') || '').slice(0, MAX_INPUT).trim()
  const term = (c.req.query('q') || '').slice(0, MAX_INPUT).trim()
  if (!city) return c.json({ points: [] })
  const like = `%${term.replace(/[%_\\]/g, (m) => '\\' + m)}%`
  const points = await q<{ id: string; name: string; address: string; working_hours: string | null; city: string }>(
    `select id::text, name, address, working_hours, city from pvz
      where enabled and city_fold = city_match($1)  -- «Moscow» из английской корзины Tilda = Москва (014_city_aliases)
        and ($2 = '' or name ilike $3 or address ilike $3)
      order by name limit 50`, [city, term, like])
  return c.json({ points: points.map((p) => ({ id: p.id, name: pointTitle(p), address: p.address, hours: p.working_hours })) })
})

widget.get('/quote', async (c) => {
  const r = await resolveShop(c)
  if ('error' in r) return r.error
  if (await limited(c)) return c.json({ available: false, reason: 'busy', message: 'Слишком много запросов, попробуйте через минуту' }, 429)
  const s = r.shop
  const pvzId = Number(c.req.query('pvz'))
  const goodsRub = Math.max(0, Math.min(10_000_000, Number(c.req.query('goods')) || 0))
  if (!Number.isSafeInteger(pvzId) || pvzId <= 0) return c.json({ available: false, reason: 'bad_pvz', message: 'Выберите пункт выдачи' })
  if (!s.origin_code) return c.json({ available: false, reason: 'not_configured', message: 'Доставка Ozon пока не настроена' })

  const point = await one<{ city: string; city_key: string }>('select city, city_key from pvz where id = $1 and enabled', [pvzId])
  if (!point) return c.json({ available: false, reason: 'bad_pvz', message: 'Пункт выдачи не найден — выберите другой' })

  const pricing = { markupPct: Number(s.markup_pct), freeFromRub: s.free_from_rub, insuranceInPrice: s.insurance_in_price }
  const goodsKop = Math.round(goodsRub * 100)
  const box = boxOf(s.box_l_cm, s.box_w_cm, s.box_h_cm, s.box_weight_g)
  const originCode = s.origin_code
  async function quoteAs(acc: OzonAccount) {
    const methodId = await ensureShipmentMethod(originCode, acc)
    return quotePvz({ account: acc, originCode, shipmentMethodId: methodId ?? 0, pvzId, box },
      async () => methodId === null || (await rateHit('global:ozon-miss', 3600)) > config.ozon.missesPerHour)
  }
  const acc = await accountOf(s.id)
  let res
  try {
    res = await quoteAs(acc)
  } catch (e) {
    if (!(e instanceof OzonAuthError) || !acc.creds) throw e
    res = { ok: false as const, permanent: false, code: 'shop_keys', message: '' }
  }
  // Ключи магазина перестали работать: отключаем их и считаем аккаунтом сервиса.
  if (!res.ok && res.code === 'shop_keys') {
    await markKeysBroken(s.id)
    res = await quoteAs(SERVICE_ACCOUNT)
  }

  if (!res.ok) {
    if (res.permanent) return c.json({ available: false, reason: 'not_deliverable', message: res.message })
    // Связь с Ozon или лимит: заказ не теряем, берём резервную цену магазина.
    const fb = customerPrice(0, goodsKop, { ...pricing, insuranceInPrice: false })
    const priceRub = fb.free ? 0 : s.fallback_rub
    await countQuote(s.id, point, priceRub)
    return c.json({ available: true, priceRub, free: fb.free, days: null, fallback: true })
  }
  const price = customerPrice(res.deliveryKop, goodsKop, pricing)
  await countQuote(s.id, point, price.priceRub)
  return c.json({ available: true, priceRub: price.priceRub, free: price.free, days: res.days, fallback: false })
})

/** Заголовок пункта для покупателя: у Ozon почти все называются «Пункт Ozon», поэтому
 *  показываем короткий адрес — всё, что после города («Сормовская улица, 9/1»). */
export function pointTitle(p: { name: string; address: string; city: string }): string {
  if (p.name && !/^пункт ozon$/i.test(p.name.trim())) return p.name
  const i = p.address.indexOf(`${p.city},`)
  const tail = i >= 0 ? p.address.slice(i + p.city.length + 1).trim() : p.address
  return tail ? `Ozon, ${tail}` : p.name
}

async function countQuote(shopId: string, point: { city: string; city_key: string }, priceRub: number) {
  await q(`insert into stats_daily (shop_id, day, city_key, city, quotes, sum_rub)
           values ($1, (now() at time zone 'Europe/Moscow')::date, $2, $3, 1, $4)
           on conflict (shop_id, day, city_key) do update
             set quotes = stats_daily.quotes + 1, sum_rub = stats_daily.sum_rub + excluded.sum_rub`,
  [shopId, point.city_key, point.city, priceRub])
}
