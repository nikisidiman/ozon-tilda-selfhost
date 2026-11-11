// Проверка ключей магазина (ozon-tilda setup / check): по одному вызову на каждую галочку (скоуп), которую
// магазин должен отметить в Ozon Доставке. Нет права — Ozon отвечает 401/403, и мы называем
// галочку словами из формы Ozon.

import { config } from '../config.js'
import { one } from '../db.js'
import { callOzon, OzonAuthError, OzonConfigError, token, tokenHasDeliveryAccess, type OzonResponse } from './client.js'
import { shipmentMethod } from './origins.js'
import type { OzonAccount } from './shop-keys.js'
import { kopToMoney } from '../lib/price.js'

/** Ключи приложения из кабинета продавца: Ozon их принимает, но к Доставке у них доступа нет. */
export const SELLER_KEYS = 'Это ключи Ozon Seller API (кабинета продавца seller.ozon.ru), а нужны ключи Ozon Доставки для бизнеса '
  + '(dostavka.ozon.ru → «Для бизнеса»). Создайте там частное приложение и вставьте его Client ID и Client Secret.'

export interface KeyStep { key: string; title: string; ok: boolean; message?: string }

export const STEP_TITLES: Record<string, string> = {
  token: 'Client ID и Client Secret',
  'delivery-point': 'Методы для получения информации по пунктам выдачи',
  delivery: 'Методы для проверки доступности доставки и сроков',
  'dropoff-point': 'Методы подбора пункта отгрузки',
  'shipment-method': 'Методы для настройки методов доставки',
  order: 'Методы для оформления заказа',
}

const denied = (r: OzonResponse<unknown>) => r.status === 401 || r.status === 403
const noScope = 'Не отмечена галочка в настройках приложения Ozon'

export async function verifyShopKeys(acc: OzonAccount, originCode: string): Promise<KeyStep[]> {
  const steps: KeyStep[] = []
  const step = (key: string, ok: boolean, message?: string) => { steps.push({ key, title: STEP_TITLES[key], ok, message }); return ok }
  if (config.ozon.mode === 'mock') {
    for (const k of Object.keys(STEP_TITLES)) step(k, true, 'тестовый режим сервиса — Ozon не вызывался')
    return steps
  }

  try {
    const t = await token(acc.creds, true)
    if (tokenHasDeliveryAccess(t) === false) {
      step('token', false, SELLER_KEYS)
      return steps
    }
    step('token', true)
  } catch (e) {
    if (e instanceof OzonAuthError) step('token', false, 'Ozon не принял ключи — проверьте, что скопировали Client ID и Client Secret целиком')
    else if (e instanceof OzonConfigError) step('token', false, 'Ozon не ответил — попробуйте через минуту')
    else throw e
    return steps
  }

  const points = await callOzon('/v1/delivery-point/list', { pagination: { limit: 1 } }, acc.creds)
  step('delivery-point', !denied(points), denied(points) ? noScope : undefined)

  const check = await callOzon('/v1/delivery/check-client', { phone_number: acc.phone }, acc.creds)
  step('delivery', !denied(check), denied(check) ? noScope : undefined)

  // Поиск пункта отгрузки и создание метода доставки — внутри shipmentMethod.
  const m = await shipmentMethod(originCode, acc)
  if (m.id) {
    step('dropoff-point', true)
    step('shipment-method', true)
  } else if (m.failed?.path === '/v1/dropoff-point/search') {
    step('dropoff-point', false, m.failed.status === 401 || m.failed.status === 403 ? noScope : m.failed.message)
    step('shipment-method', false, 'Не проверено: сначала нужен пункт отгрузки')
  } else {
    step('dropoff-point', true)
    const f = m.failed
    step('shipment-method', false, !f ? 'Город отгрузки не выбран' : f.status === 401 || f.status === 403 ? noScope : f.message)
  }

  // Расчёт до любого пункта выдачи в другом городе: важен не ответ, а то, что Ozon пустил к методу.
  const pvz = await one<{ id: string }>(
    `select p.id::text from pvz p join origins o on o.code = $1
      where p.enabled and p.city_key <> city_key(o.city) order by p.id limit 1`, [originCode])
  if (!pvz) {
    step('order', false, 'Реестр пунктов выдачи ещё загружается — проверьте через несколько минут')
  } else {
    const r = await callOzon('/v1/order/checkout', {
      recipient: { phone_number: config.ozon.servicePhone ?? acc.phone },
      postings: [{
        request_id: 1, shipment_method_id: m.id ?? 0,
        declared_value: { amount: kopToMoney(200_000), currency_code: 'RUB' },
        dimensions: { length_mm: 300, width_mm: 200, height_mm: 100, weight_g: 1000 },
      }],
      delivery: { delivery_point: { delivery_point_id: Number(pvz.id) } },
    }, acc.creds)
    step('order', !denied(r), denied(r) ? noScope : undefined)
  }
  return steps
}
