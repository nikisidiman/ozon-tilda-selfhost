// Цена Ozon до ПВЗ с кешем по (аккаунт Ozon, город отгрузки, ПВЗ, коробка).

import { config } from '../config.js'
import { one, q } from '../db.js'
import { callOzon, ozonErrorOf, OzonAuthError, OzonConfigError } from './client.js'
import { SERVICE_ACCOUNT, type OzonAccount } from './shop-keys.js'
import { kopToMoney, moneyToKop } from '../lib/price.js'

const TTL_MS = 24 * 60 * 60_000
/** Объявленная стоимость для расчёта: на цену доставки не влияет (по замерам). */
const DECLARED_KOP = 200_000

export function errorKey(code: string | null | undefined): string {
  return String(code ?? '').replace(/[_\s-]/g, '').toLowerCase()
}

const PERMANENT = new Set([
  'deliveryavailabilityerror', 'deliverypointnotfound', 'samedeliverypointerror',
  'deliverypointrestrictionserror',
])

export function isPermanent(code: string | null, status: number): boolean {
  if (PERMANENT.has(errorKey(code))) return true
  return status >= 400 && status < 500 && status !== 429 && status !== 401 && errorKey(code) !== 'recipienterror'
}

export function explainOzonError(code: string | null): string {
  switch (errorKey(code)) {
    case 'deliveryavailabilityerror': return 'Ozon не возит в этот пункт выдачи'
    case 'deliverypointnotfound': return 'Пункт выдачи не найден у Ozon'
    case 'deliverypointrestrictionserror': return 'Пункт выдачи не принимает посылку такого размера'
    case 'samedeliverypointerror': return 'Пункт выдачи совпадает с пунктом отгрузки'
    default: return 'Ozon не может доставить в этот пункт выдачи'
  }
}

export type PvzQuote =
  | { ok: true; deliveryKop: number; days: number | null; cached: boolean }
  | { ok: false; permanent: boolean; code: string | null; message: string }

export interface QuoteInput {
  /** Чьим аккаунтом считаем; по умолчанию — сервиса. */
  account?: OzonAccount
  originCode: string
  shipmentMethodId: number
  pvzId: number
  box: { dims: { length_mm: number; width_mm: number; height_mm: number; weight_g: number }; key: string }
}

export interface MissGuard { (): Promise<boolean> }

/** Детерминированная «цена» для режима без ключей Ozon: 150–450 ₽, растёт с объёмом коробки. */
export function mockQuote(pvzId: number, boxKey: string): { deliveryKop: number; days: number } {
  let h = 2166136261
  for (const ch of `${pvzId}:${boxKey}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  const [l, w, hh] = boxKey.split(/[x-]/).map((v) => parseInt(v, 10))
  const liters = (l * w * hh) / 1e6
  const base = 15000 + (Math.abs(h) % 20000)
  return { deliveryKop: Math.round(base + Math.min(liters, 60) * 400), days: 2 + (Math.abs(h) % 6) }
}

export async function quotePvz(input: QuoteInput, overLimit: MissGuard): Promise<PvzQuote> {
  const acc = input.account ?? SERVICE_ACCOUNT
  const cached = await one<{ delivery_kop: number | null; days: number | null; error_code: string | null; fetched_at: Date }>(
    'select delivery_kop, days, error_code, fetched_at from quote_cache where account=$1 and origin_code=$2 and pvz_id=$3 and box_key=$4',
    [acc.id, input.originCode, input.pvzId, input.box.key],
  )
  if (cached && Date.now() - cached.fetched_at.getTime() < TTL_MS) {
    if (cached.delivery_kop !== null) return { ok: true, deliveryKop: cached.delivery_kop, days: cached.days, cached: true }
    return { ok: false, permanent: true, code: cached.error_code, message: explainOzonError(cached.error_code) }
  }

  if (config.ozon.mode === 'mock') {
    const m = mockQuote(input.pvzId, input.box.key)
    await save(input, m.deliveryKop, m.days, null)
    return { ok: true, deliveryKop: m.deliveryKop, days: m.days, cached: false }
  }

  if (await overLimit()) {
    console.error('[quote] потолок запросов к Ozon на час исчерпан')
    return { ok: false, permanent: false, code: 'rate_limited', message: 'Расчёт временно недоступен' }
  }
  if (!config.ozon.servicePhone) {
    console.error('[quote] не задан OZON_SERVICE_PHONE')
    return { ok: false, permanent: false, code: 'config', message: 'Расчёт временно недоступен' }
  }

  let r
  try {
    r = await callOzon<{ results?: { posting?: { estimated_delivery_cost?: { amount?: unknown }; estimated_delivery_days?: unknown } | null }[] }>(
      '/v1/order/checkout', {
        recipient: { phone_number: config.ozon.servicePhone },
        postings: [{
          request_id: 1,
          shipment_method_id: input.shipmentMethodId,
          declared_value: { amount: kopToMoney(DECLARED_KOP), currency_code: 'RUB' },
          dimensions: input.box.dims,
        }],
        delivery: { delivery_point: { delivery_point_id: input.pvzId } },
      }, acc.creds)
  } catch (e) {
    if (e instanceof OzonConfigError) {
      console.error('[quote]', acc.id, e.message)
      const code = e instanceof OzonAuthError && acc.creds ? 'shop_keys' : 'config'
      return { ok: false, permanent: false, code, message: 'Расчёт временно недоступен' }
    }
    throw e
  }

  const posting = r.ok ? r.body?.results?.[0]?.posting : null
  const kop = moneyToKop(posting?.estimated_delivery_cost?.amount)
  if (posting && kop !== null) {
    const d = Number(posting.estimated_delivery_days)
    const days = Number.isFinite(d) && d > 0 ? d : null
    await save(input, kop, days, null)
    return { ok: true, deliveryKop: kop, days, cached: false }
  }
  const err = ozonErrorOf(r)
  let permanent = isPermanent(err.code, r.ok ? 400 : r.status)
  // «Пункт не найден» для пункта из нашего реестра — обычно свежий метод доставки ещё не
  // разошёлся по Ozon (первые минуты после создания). Не кешируем и не считаем окончательным.
  if (permanent && errorKey(err.code) === 'deliverypointnotfound') {
    const known = await one('select 1 from pvz where id = $1 and enabled', [input.pvzId])
    if (known) permanent = false
  }
  if (errorKey(err.code) === 'recipienterror') console.error('[quote] служебный номер отклонён Ozon (recipient_error) — проверьте OZON_SERVICE_PHONE')
  // Ключи магазина без нужной галочки или отозваны.
  if (acc.creds && (r.status === 401 || r.status === 403)) return { ok: false, permanent: false, code: 'shop_keys', message: 'Расчёт временно недоступен' }
  if (permanent) await save(input, null, null, err.code)
  else console.error('[quote] временная ошибка Ozon', r.status, err.code)
  return { ok: false, permanent, code: err.code, message: explainOzonError(err.code) }
}

async function save(i: QuoteInput, kop: number | null, days: number | null, code: string | null) {
  await q(`insert into quote_cache (account, origin_code, pvz_id, box_key, delivery_kop, days, error_code, fetched_at)
           values ($1,$2,$3,$4,$5,$6,$7, now())
           on conflict (account, origin_code, pvz_id, box_key) do update
             set delivery_kop=excluded.delivery_kop, days=excluded.days, error_code=excluded.error_code, fetched_at=now()`,
  [(i.account ?? SERVICE_ACCOUNT).id, i.originCode, i.pvzId, i.box.key, kop, days, code])
}
