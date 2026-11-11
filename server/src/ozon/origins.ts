// Метод доставки Ozon для города отгрузки. Один метод на город хватает: цена зависит от
// города отгрузки и пункта выдачи, а не от конкретного ПВЗ, куда магазин сдаёт посылку.
// Метод создаётся при первом выборе города: в аккаунте Ozon Доставки владельца сервиса
// (origins.shipment_method_id) или, если магазин подключил свои ключи, в его аккаунте
// (shop_shipment_methods).

import { config } from '../config.js'
import { one, q } from '../db.js'
import { callOzon, ozonErrorOf } from './client.js'
import { SERVICE_ACCOUNT, type OzonAccount } from './shop-keys.js'

interface DropoffPoint {
  dropoff_point_id: number; type: string; full_address?: string
  coordinates?: { latitude?: number; longitude?: number }
  is_return_point_available?: boolean; capacity_percentage?: number
}

/** Чем закончилось создание метода; failed — первый вызов Ozon, который не удался. */
export interface MethodResult { id: number | null; failed?: { path: string; status: number; message: string } }

const pending = new Map<string, Promise<MethodResult>>()

export async function ensureShipmentMethod(code: string, acc: OzonAccount = SERVICE_ACCOUNT): Promise<number | null> {
  return (await shipmentMethod(code, acc)).id
}

export async function shipmentMethod(code: string, acc: OzonAccount = SERVICE_ACCOUNT): Promise<MethodResult> {
  const o = await one<{ city: string; shipment_method_id: string | null; lat: number | null; lon: number | null }>(
    'select city, shipment_method_id, lat, lon from origins where code = $1 and active', [code])
  if (!o) return { id: null }
  const own = acc.creds
    ? (await one<{ shipment_method_id: string }>('select shipment_method_id from shop_shipment_methods where shop_id = $1 and origin_code = $2', [acc.id, code]))?.shipment_method_id ?? null
    : o.shipment_method_id
  if (own) return { id: Number(own) }
  if (config.ozon.mode !== 'live' || o.lat === null || o.lon === null) return { id: null }
  const key = `${acc.id}:${code}`
  if (!pending.has(key)) {
    pending.set(key, create(acc, code, o.city, o.lat, o.lon).finally(() => pending.delete(key)))
  }
  return pending.get(key)!
}

async function create(acc: OzonAccount, code: string, city: string, lat: number, lon: number): Promise<MethodResult> {
  const who = acc.creds ? `магазин ${acc.id}` : 'сервис'
  const d = 0.08
  const r = await callOzon<{ dropoff_points?: DropoffPoint[] }>('/v1/dropoff-point/search', {
    filters: { is_bulky: false, viewport: { left_bottom: { latitude: lat - d, longitude: lon - d }, right_top: { latitude: lat + d, longitude: lon + d } } },
    pagination: { limit: 100 },
  }, acc.creds)
  if (!r.ok) {
    const message = ozonErrorOf(r).message
    console.error(`[origins] ${who}, ${city}: поиск пункта отгрузки`, r.status, message)
    return { id: null, failed: { path: '/v1/dropoff-point/search', status: r.status, message } }
  }
  const d2 = (p: DropoffPoint) => ((p.coordinates?.latitude ?? 0) - lat) ** 2 + ((p.coordinates?.longitude ?? 0) - lon) ** 2
  const candidates = (r.body?.dropoff_points ?? [])
    .filter((p) => p.type === 'pvz' && p.is_return_point_available !== false && (p.capacity_percentage ?? 0) < 90)
    .sort((a, b) => d2(a) - d2(b))
  // Ozon не даёт два метода с одним названием («Недопустимое название метода»), а старый метод
  // остаётся в кабинете, когда магазин меняет ключи, — поэтому метка времени в названии.
  const stamp = Date.now().toString(36)
  let failed: MethodResult['failed']
  for (const p of candidates.slice(0, 5)) {
    const c = await callOzon<{ shipment_method_id?: number; shipment_method?: { shipment_method_id?: number }; error?: { message?: string } }>(
      '/v1/shipment-method/create', {
        name: `${city} — ${acc.creds ? 'Tilda' : 'расчёт'} ${stamp} (${p.full_address ?? p.dropoff_point_id})`.slice(0, 120),
        phone_number: acc.phone ?? config.ozon.servicePhone,
        is_bulky: false,
        type: { dropoff: { dropoff_point_id: p.dropoff_point_id, return_point_id: p.dropoff_point_id } },
      }, acc.creds)
    const id = c.body?.shipment_method_id ?? c.body?.shipment_method?.shipment_method_id
    if (c.ok && id) {
      if (acc.creds) {
        await q(`insert into shop_shipment_methods (shop_id, origin_code, shipment_method_id, dropoff_address) values ($1, $2, $3, $4)
                 on conflict (shop_id, origin_code) do update set shipment_method_id = excluded.shipment_method_id, dropoff_address = excluded.dropoff_address`,
        [acc.id, code, id, p.full_address ?? null])
      } else {
        await q('update origins set shipment_method_id = $1, dropoff_address = $2 where code = $3', [id, p.full_address ?? null, code])
      }
      console.log(`[origins] ${who}, ${city}: создан метод ${id} (${p.full_address})`)
      return { id }
    }
    const message = ozonErrorOf(c).message
    failed = { path: '/v1/shipment-method/create', status: c.status, message }
    console.error(`[origins] ${who}, ${city}: пункт ${p.dropoff_point_id} не подошёл`, c.status, message)
    // Нет прав или ключи отозваны — другие пункты не помогут.
    if (c.status === 401 || c.status === 403) break
  }
  return { id: null, failed: failed ?? { path: '/v1/dropoff-point/search', status: 200, message: 'Рядом с городом отгрузки не нашлось пункта приёма' } }
}
