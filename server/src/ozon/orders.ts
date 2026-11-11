// Заказ Tilda → отправление в кабинете Ozon Доставки магазина (его ключами).
// Порядок: строка журнала ДО create —
// уникальный индекс не даёт второму вебхуку создать второе отправление; create без повторов
// вслепую; approve — только если магазин так настроил (корзина шлёт лишь оплаченные заказы).
// Без approve отправление висит в кабинете неподтверждённым: магазин подтверждает или удаляет.

import { config } from '../config.js'
import { one, q } from '../db.js'
import { boxOf, kopToMoney } from '../lib/price.js'
import type { TildaOrder } from '../lib/tilda-order.js'
import { callOzon, ozonErrorOf, OzonConfigError, POSTING_SCOPE, type OzonResponse } from './client.js'
import { ensureShipmentMethod } from './origins.js'
import { errorKey, explainOzonError } from './quote.js'
import { accountOf, normalizePhone } from './shop-keys.js'

export interface OrderShop {
  id: string; origin_code: string | null; box_l_cm: number; box_w_cm: number; box_h_cm: number; box_weight_g: number
  ozon_orders_approve: boolean
}

export type OrderStatus = 'skipped' | 'duplicate' | 'failed' | 'unknown' | 'created' | 'approved'

/** Объявленная стоимость не может быть нулевой. */
const MIN_DECLARED_KOP = 10_000

function explain(r: OzonResponse<unknown>): string {
  const err = ozonErrorOf(r)
  const k = errorKey(err.code)
  if (k === 'recipienterror') return 'На номер покупателя нет аккаунта Ozon — Ozon не выдаст ему заказ'
  if (['deliveryavailabilityerror', 'deliverypointnotfound', 'deliverypointrestrictionserror', 'samedeliverypointerror'].includes(k)) return explainOzonError(err.code)
  if (r.status === 401 || r.status === 403) return 'Ключам Ozon не хватает прав — проверьте галочки приложения в кабинете Ozon Доставки'
  if (r.status === 0) return 'Ozon не ответил'
  return `Ozon: ${err.message}`.slice(0, 300)
}

async function finish(id: string, status: OrderStatus, fields: { posting?: string | null; error?: string | null } = {}) {
  await q(`update shop_orders set status=$1, posting_number=coalesce($2, posting_number), error=$3, updated_at=now() where id=$4`,
    [status, fields.posting ?? null, fields.error ?? null, id])
}

export async function sendOrder(shop: OrderShop, order: TildaOrder): Promise<{ status: OrderStatus; message?: string }> {
  // Доставка не Ozon (или пункт не выбран) — это не наш заказ.
  if (!order.pvzId) return { status: 'skipped' }

  // Габариты и вес есть у всех товаров корзины — посылка по ним; иначе типовая коробка магазина.
  const p = order.parcel
  const fromItems = !!p && p.weight_g !== null
  const dims = fromItems
    ? { length_mm: p!.length_mm, width_mm: p!.width_mm, height_mm: p!.height_mm, weight_g: p!.weight_g! }
    : boxOf(shop.box_l_cm, shop.box_w_cm, shop.box_h_cm, shop.box_weight_g).dims
  const row = await one<{ id: string }>(
    `insert into shop_orders (shop_id, tilda_order_id, pvz_id, goods_kop, dims) values ($1,$2,$3,$4,$5)
     on conflict (shop_id, tilda_order_id) do nothing returning id`,
    [shop.id, order.orderId, order.pvzId, order.goodsKop, JSON.stringify({ ...dims, source: fromItems ? 'items' : 'shop' })])
  if (!row) return { status: 'duplicate' }

  const fail = async (message: string) => { await finish(row.id, 'failed', { error: message }); return { status: 'failed' as const, message } }

  const acc = await accountOf(shop.id)
  if (!acc.creds) return fail('Ключи Ozon Доставки не подключены или перестали работать')
  if (!shop.origin_code) return fail('Не выбран город отгрузки')
  const phone = normalizePhone(order.phone ?? '')
  if (!phone) return fail('В заказе нет российского мобильного номера покупателя')
  if (!order.name) return fail('В заказе нет имени покупателя')

  if (config.ozon.mode === 'mock') {
    await finish(row.id, shop.ozon_orders_approve ? 'approved' : 'created', { posting: `MOCK-${order.orderId}` })
    return { status: shop.ozon_orders_approve ? 'approved' : 'created' }
  }

  try {
    const methodId = await ensureShipmentMethod(shop.origin_code, acc)
    if (!methodId) return fail('Метод доставки Ozon для города отгрузки ещё не создан — попробуйте позже')

    const externalId = `tilda-${order.orderId}`
    const created = await callOzon<{ postings?: { posting_number?: string }[] }>('/v1/order/create', {
      order_external_id: externalId,
      recipient: { phone_number: phone, full_name: order.name },
      delivery: { delivery_point: { delivery_point_id: order.pvzId } },
      postings: [{
        request_id: 1,
        posting_external_id: externalId,
        shipment_method_id: methodId,
        description: order.description,
        declared_value: { amount: kopToMoney(Math.max(order.goodsKop, MIN_DECLARED_KOP)), currency_code: 'RUB' },
        dimensions: dims,
      }],
    }, acc.creds, { once: true })
    const posting = created.ok ? created.body?.postings?.[0]?.posting_number : null
    if (!posting) {
      // Нет ответа или 5xx — Ozon мог создать отправление и не успеть ответить. Не повторяем.
      if (created.status === 0 || created.status >= 500) {
        const message = 'Ozon не ответил — проверьте, появилось ли отправление в кабинете Ozon Доставки'
        await finish(row.id, 'unknown', { error: message })
        return { status: 'unknown', message }
      }
      return fail(explain(created))
    }
    if (!shop.ozon_orders_approve) {
      await finish(row.id, 'created', { posting })
      return { status: 'created' }
    }
    // Отправление уже есть: любой сбой подтверждения — не ошибка создания, магазин подтвердит сам.
    let why: string
    try {
      const approved = await callOzon('/v1/posting/approve', { posting_number: posting },
        { ...acc.creds, scopes: [...acc.creds.scopes, POSTING_SCOPE] })
      if (approved.ok) {
        await finish(row.id, 'approved', { posting })
        return { status: 'approved' }
      }
      why = explain(approved)
    } catch (e) {
      if (!(e instanceof OzonConfigError)) console.error('[orders] approve', posting, (e as Error).message)
      why = e instanceof OzonConfigError ? 'нет галочки «Методы для работы с отправлениями» в приложении Ozon' : 'сбой связи с Ozon'
    }
    const message = `Отправление создано, но не подтверждено: ${why}`
    await finish(row.id, 'created', { posting, error: message })
    return { status: 'created', message }
  } catch (e) {
    if (e instanceof OzonConfigError) return fail('Ozon не принял ключи магазина')
    await finish(row.id, 'unknown', { error: 'Сбой при отправке — проверьте кабинет Ozon Доставки' })
    throw e
  }
}
