// Можно ли доставить на номер покупателя: Ozon выдаёт заказ только владельцу аккаунта Ozon
// на этот номер. Проверка — ключами магазина (/v1/delivery/check-client), кеш:
// «да» живёт долго, «нет» — недолго, чтобы
// покупатель, который только что завёл аккаунт, не ждал.

import { config } from '../config.js'
import { one, q } from '../db.js'
import { callOzon, OzonConfigError, OzonAuthError } from './client.js'
import { phoneHash, type OzonAccount } from './shop-keys.js'

const YES_TTL_MS = 30 * 24 * 60 * 60_000
const NO_TTL_MS = 60 * 60_000

export type PhoneCheck =
  | { ok: true; canDeliver: boolean; cached: boolean }
  | { ok: false; code: 'unavailable' | 'shop_keys' }

/** phone — уже нормализованный +79XXXXXXXXX. */
export async function checkPhone(acc: OzonAccount, phone: string, overLimit: () => Promise<boolean>): Promise<PhoneCheck> {
  const hash = phoneHash(phone)
  const cached = await one<{ can_be_delivered: boolean; checked_at: Date }>(
    'select can_be_delivered, checked_at from phone_checks where account = $1 and phone_hash = $2', [acc.id, hash])
  if (cached && Date.now() - cached.checked_at.getTime() < (cached.can_be_delivered ? YES_TTL_MS : NO_TTL_MS)) {
    return { ok: true, canDeliver: cached.can_be_delivered, cached: true }
  }
  if (config.ozon.mode === 'mock') return { ok: true, canDeliver: !phone.endsWith('0000'), cached: false }
  if (await overLimit()) return { ok: false, code: 'unavailable' }

  let r
  try {
    r = await callOzon<{ can_be_delivered?: unknown }>('/v1/delivery/check-client', { phone_number: phone }, acc.creds)
  } catch (e) {
    if (e instanceof OzonAuthError) return { ok: false, code: 'shop_keys' }
    if (e instanceof OzonConfigError) return { ok: false, code: 'unavailable' }
    throw e
  }
  if (r.status === 401 || r.status === 403) return { ok: false, code: 'shop_keys' }
  if (!r.ok || typeof r.body?.can_be_delivered !== 'boolean') {
    console.error('[check-client] ответ без can_be_delivered', r.status)
    return { ok: false, code: 'unavailable' }
  }
  const can = r.body.can_be_delivered
  await q(`insert into phone_checks (account, phone_hash, can_be_delivered, checked_at) values ($1, $2, $3, now())
           on conflict (account, phone_hash) do update set can_be_delivered = excluded.can_be_delivered, checked_at = now()`,
  [acc.id, hash, can])
  return { ok: true, canDeliver: can, cached: false }
}
