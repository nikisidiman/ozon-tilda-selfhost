// Необязательные ключи Ozon Доставки магазина. С ними виджет проверяет номер покупателя
// (есть ли аккаунт Ozon), а цену считает по договору и точке отгрузки самого магазина.
// Client Secret хранится зашифрованным (AES-256-GCM, ключ SHOP_KEYS_KEY вне базы) и
// наружу не отдаётся; номера покупателей — только как HMAC от того же ключа.

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { config } from '../config.js'
import { one, q } from '../db.js'
import { SHOP_SCOPES, type OzonCreds } from './client.js'

/** Чьим аккаунтом Ozon считаем: сервиса ('svc') или магазина (id магазина). */
export interface OzonAccount {
  id: string
  creds?: OzonCreds
  /** Контактный номер магазина для метода доставки в его аккаунте. */
  phone?: string
}

export const SERVICE_ACCOUNT: OzonAccount = { id: 'svc' }

function masterKey(): Buffer | null {
  const raw = config.ozon.shopKeysKey
  if (!raw) return null
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new Error('SHOP_KEYS_KEY должен быть 32 байтами в base64')
  return key
}

function subKey(purpose: string): Buffer {
  const key = masterKey()
  if (!key) throw new Error('Не задан SHOP_KEYS_KEY')
  return Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), `ozon-tilda:${purpose}`, 32))
}

export function shopKeysEnabled(): boolean {
  return masterKey() !== null
}

/** Шифрует секрет: base64(iv | tag | шифротекст). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', subKey('secret'), iv)
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')
}

export function decryptSecret(stored: string): string {
  const b = Buffer.from(stored, 'base64')
  const d = createDecipheriv('aes-256-gcm', subKey('secret'), b.subarray(0, 12))
  d.setAuthTag(b.subarray(12, 28))
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')
}

/** Хеш номера покупателя для кеша проверок: открытый номер не храним. */
export function phoneHash(phone: string): string {
  return createHmac('sha256', subKey('phone')).update(phone).digest('hex')
}

/** Российский мобильный в виде +79XXXXXXXXX или null. Понимает маски Tilda: «+7 (999) 123-45-67», «8 999…», «999…». */
export function normalizePhone(raw: string): string | null {
  let d = String(raw || '').replace(/\D/g, '')
  if (d.length === 11 && (d[0] === '7' || d[0] === '8')) d = d.slice(1)
  return d.length === 10 && d[0] === '9' ? `+7${d}` : null
}

export function maskClientId(id: string): string {
  return id.length <= 8 ? '••••' : `${id.slice(0, 6)}…${id.slice(-4)}`
}

interface KeysRow { id: string; ozon_client_id: string | null; ozon_secret_enc: string | null; ozon_phone: string | null; ozon_keys_status: string | null }

/** Аккаунт для расчёта и проверки номера: ключи магазина, если они проверены, иначе сервиса. */
export async function accountOf(shopId: string): Promise<OzonAccount> {
  const r = await one<KeysRow>(
    'select id, ozon_client_id, ozon_secret_enc, ozon_phone, ozon_keys_status from shops where id = $1', [shopId])
  if (!r || r.ozon_keys_status !== 'ok') return SERVICE_ACCOUNT
  return shopAccount(r) ?? SERVICE_ACCOUNT
}

export function shopAccount(r: KeysRow): OzonAccount | null {
  if (!r.ozon_client_id || !r.ozon_secret_enc || !shopKeysEnabled()) return null
  try {
    return {
      id: r.id,
      creds: { clientId: r.ozon_client_id, clientSecret: decryptSecret(r.ozon_secret_enc), scopes: SHOP_SCOPES },
      phone: r.ozon_phone ?? undefined,
    }
  } catch (e) {
    console.error('[shop-keys] не расшифровать ключ магазина', r.id, (e as Error).message)
    return null
  }
}

/** Ozon отверг ключи магазина: перестаём ими пользоваться, видно в ozon-tilda show. */
export async function markKeysBroken(shopId: string): Promise<void> {
  await q(`update shops set ozon_keys_status = 'broken', ozon_keys_checked_at = now() where id = $1 and ozon_keys_status = 'ok'`, [shopId])
}
