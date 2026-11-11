// Вебхук Tilda «Сервисы приёма данных → Webhook»: заказ корзины → отправление Ozon.
// Адрес содержит секрет магазина (hook_token): публичный ключ виден в коде сайта.
// Tilda ждёт ответа «ok» за несколько секунд, поэтому отправление создаём в фоне.
// Каждый запрос пишем в hook_log (тело — без данных покупателя): по нему ozon-tilda logs
// показывает, доходят ли вебхуки и почему заказ не ушёл в Ozon.

import { Hono } from 'hono'
import { one, q } from '../db.js'
import { rateHit } from '../lib/security.js'
import { isTildaTest, maskPersonal, parseTildaBody, shapeOf, tildaOrder } from '../lib/tilda-order.js'
import { sendOrder, type OrderShop } from '../ozon/orders.js'

const MAX_BODY = 200_000
const PER_SHOP_HOUR = 600
const LOG_PER_HOUR = 1000      // журнал не должен расти от мусорных запросов
const LOG_BODY_MAX = 50_000

export const hook = new Hono()

type HookResult = 'accepted' | 'unknown_token' | 'test' | 'disabled' | 'busy' | 'no_order' | 'no_pvz'

async function logHook(shopId: string | null, result: HookResult, orderId: string | null, body: Record<string, unknown>) {
  try {
    if ((await rateHit('hook-log', 3600)) > LOG_PER_HOUR) return
    let saved = JSON.stringify(maskPersonal(body))
    if (saved.length > LOG_BODY_MAX) saved = JSON.stringify({ _truncated: true, shape: shapeOf(body) })
    await q('insert into hook_log (shop_id, result, tilda_order_id, body) values ($1, $2, $3, $4)',
      [shopId, result, orderId, saved])
  } catch (e) {
    console.error('[hook-log]', e instanceof Error ? e.message : String(e))
  }
}

hook.post('/tilda/:token', async (c) => {
  const token = c.req.param('token')
  const body = parseTildaBody((await c.req.text()).slice(0, MAX_BODY), c.req.header('content-type') ?? '')
  const shop = /^[\w-]{20,64}$/.test(token) ? await one<OrderShop & { ozon_orders_enabled: boolean }>(
    `select id, origin_code, box_l_cm, box_w_cm, box_h_cm, box_weight_g, ozon_orders_enabled, ozon_orders_approve
       from shops where hook_token = $1`, [token]) : null
  if (!shop) { await logHook(null, 'unknown_token', null, body); return c.text('unknown', 404) }
  if (isTildaTest(body)) { await logHook(shop.id, 'test', null, body); return c.text('ok') }
  const order = tildaOrder(body)
  const orderId = order?.orderId ?? null
  if (!shop.ozon_orders_enabled) { await logHook(shop.id, 'disabled', orderId, body); return c.text('ok') }
  if ((await rateHit(`hook:${shop.id}`, 3600)) > PER_SHOP_HOUR) { await logHook(shop.id, 'busy', orderId, body); return c.text('busy', 429) }
  if (!order || !order.pvzId) {
    await logHook(shop.id, order ? 'no_pvz' : 'no_order', orderId, body)
    console.log(`[orders] магазин ${shop.id}: ${order ? 'без пункта Ozon' : 'нет номера заказа'}, поля ${JSON.stringify(shapeOf(body))}`)
    return c.text('ok')
  }
  await logHook(shop.id, 'accepted', orderId, body)
  // В журнал — без данных покупателя.
  sendOrder(shop, order)
    .then((r) => { if (r.status !== 'skipped') console.log(`[orders] магазин ${shop.id}, заказ ${order.orderId}: ${r.status}${r.message ? ` — ${r.message}` : ''}`) })
    .catch((e) => console.error('[orders]', shop.id, order.orderId, e instanceof Error ? e.message : String(e)))
  return c.text('ok')
})
