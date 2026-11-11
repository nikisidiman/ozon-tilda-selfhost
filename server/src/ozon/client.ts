// Клиент Ozon Delivery API (Ozon Доставка для бизнеса).
//
// Две особенности, без которых клиент молча не работает:
//   • антибот testcookie: сервер может ответить 302/307 с Set-Cookie и Location,
//     и запрос надо повторить по Location с тем же телом и этой cookie. fetch по
//     умолчанию превращает 302 в GET без тела, поэтому редиректы — вручную;
//   • cookie храним ОТДЕЛЬНО на каждый хост: cookie xapi.ozon.ru, отправленная в
//     api-delivery.ozon.ru, подвешивала запрос до таймаута (06.10.2026).

import { randomUUID } from 'node:crypto'
import { config } from '../config.js'

export const OZON_HOST = 'https://api-delivery.ozon.ru'
const AUTH_URL = 'https://xapi.ozon.ru/oauth/token'
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const TIMEOUT_MS = 20_000

const cookieJars = new Map<string, Map<string, string>>()
const tokens = new Map<string, { value: string; expiresAt: number }>()

/** Ключи частного приложения Ozon Доставки: сервиса (из .env) или магазина (из базы, shops.ozon_*). */
export interface OzonCreds { clientId: string; clientSecret: string; scopes: string[] }

/** Галочки, которые магазин ставит при создании приложения, — по одной на метод, который мы вызываем.
 *  Ключ один на всё (и «сервиса», и магазина), поэтому здесь же справочник пунктов выдачи. */
export const SHOP_SCOPES = [
  'delivery-api.delivery-point',  // /v1/delivery-point/list, /info — справочник пунктов
  'delivery-api.delivery',        // /v1/delivery/check-client
  'delivery-api.order',           // /v1/order/checkout
  'delivery-api.dropoff-point',   // /v1/dropoff-point/search
  'delivery-api.shipment-method', // /v1/shipment-method/create
]

/** Ещё одна галочка, если магазин отправляет заказы в Ozon: /v1/posting/approve. */
export const POSTING_SCOPE = 'delivery-api.posting'

function jarFor(url: string) {
  const host = new URL(url).host
  let jar = cookieJars.get(host)
  if (!jar) cookieJars.set(host, (jar = new Map()))
  return jar
}

function cookieHeader(url: string): Record<string, string> {
  const jar = jarFor(url)
  return jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}
}

function remember(url: string, res: Response) {
  const jar = jarFor(url)
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(';')[0]
    const i = pair.indexOf('=')
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
  }
}

async function post(url: string, headers: Record<string, string>, body: string): Promise<Response> {
  let target = url
  for (let hop = 0; ; hop++) {
    const res = await fetch(target, {
      method: 'POST',
      headers: { ...headers, ...cookieHeader(target), 'X-Request-Id': randomUUID() },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    remember(target, res)
    const location = res.headers.get('location')
    if (!REDIRECTS.has(res.status) || !location || hop >= 3) return res
    await res.body?.cancel()
    target = new URL(location, target).toString()
  }
}

export class OzonConfigError extends Error {}
/** Ozon отверг сами ключи (неверные, удалённые или без нужных галочек) — в отличие от сбоя связи. */
export class OzonAuthError extends OzonConfigError {}

function serviceCreds(): OzonCreds {
  const { clientId, clientSecret } = config.ozon
  if (!clientId || !clientSecret) throw new OzonConfigError('Не заданы OZON_DELIVERY_CLIENT_ID / OZON_DELIVERY_CLIENT_SECRET')
  return { clientId, clientSecret, scopes: SHOP_SCOPES }
}

async function requestToken(creds: OzonCreds, scopes: string[]) {
  const res = await post(AUTH_URL, { 'Content-Type': 'application/json' }, JSON.stringify({
    client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: 'client_credentials', scope: scopes,
  }))
  const data = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null
  return { res, data }
}

export async function token(creds: OzonCreds = serviceCreds(), force = false): Promise<string> {
  // Токен с одним набором прав не годится для вызова, которому нужны другие.
  const key = `${creds.clientId}|${creds.scopes.join(',')}`
  const cached = tokens.get(key)
  if (!force && cached && cached.expiresAt > Date.now() + 60_000) return cached.value
  let { res, data } = await requestToken(creds, creds.scopes)
  // Магазин мог отметить «Все методы» вместо отдельных галочек — тогда просим all.
  if (!data?.access_token && res.status >= 400 && res.status < 500 && !creds.scopes.includes('delivery-api.all')) {
    ({ res, data } = await requestToken(creds, ['delivery-api.all']))
  }
  if (!res.ok || !data?.access_token) {
    cookieJars.delete(new URL(AUTH_URL).host)
    // Тело ответа в ошибку не кладём: там может быть эхо запроса.
    const msg = `Ozon не выдал токен (HTTP ${res.status})`
    throw res.status >= 400 && res.status < 500 && res.status !== 429 ? new OzonAuthError(msg) : new OzonConfigError(msg)
  }
  const ttl = Number(data.expires_in) > 0 ? Number(data.expires_in) : 1800
  tokens.set(key, { value: data.access_token, expiresAt: Date.now() + ttl * 1000 })
  return data.access_token
}

export interface OzonResponse<T> {
  ok: boolean
  /** 0 — ответа нет (сеть, таймаут). */
  status: number
  body: T | null
}

/** Вызов Ozon: при отсутствии ответа повторяется один раз — кроме once (создание заказа:
 *  запрос мог дойти, и повтор создал бы второе отправление). creds — ключи магазина; без них — сервиса. */
export async function callOzon<T = unknown>(path: string, payload: unknown, creds?: OzonCreds, opts: { once?: boolean } = {}): Promise<OzonResponse<T>> {
  const body = JSON.stringify(payload ?? {})
  const c = creds ?? serviceCreds()
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response
    let sent = false
    try {
      const t = await token(c, attempt > 0)
      sent = true
      res = await post(`${OZON_HOST}${path}`, {
        Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', Accept: 'application/json',
      }, body)
    } catch (e) {
      if (e instanceof OzonConfigError) throw e
      console.error('[ozon]', path, e instanceof Error ? e.message : String(e))
      cookieJars.clear()
      if (attempt === 0 && !(opts.once && sent)) continue
      return { ok: false, status: 0, body: null }
    }
    if (res.status === 401 && attempt === 0) { await res.body?.cancel(); continue }
    const text = await res.text()
    let parsed: unknown = null
    try { parsed = text ? JSON.parse(text) : {} } catch { parsed = { raw: text.slice(0, 300) } }
    return { ok: res.ok, status: res.status, body: parsed as T }
  }
  return { ok: false, status: 401, body: null }
}

interface OzonErr { code?: unknown; message?: unknown }
export interface OzonErrorBody extends OzonErr { error?: OzonErr | null; results?: { error?: OzonErr | null }[] }

export function ozonErrorOf(r: OzonResponse<unknown>): { code: string | null; message: string } {
  if (r.status === 0) return { code: 'no_response', message: 'Ozon не ответил' }
  const b = (r.body as OzonErrorBody | null) ?? {}
  const item = b.results?.[0]?.error ?? b.error ?? null
  const code = item?.code ?? b.code ?? null
  const msg = item?.message ?? b.message ?? null
  return { code: code ? String(code) : null, message: msg ? String(msg) : `Ozon ответил HTTP ${r.status}` }
}

/** Даёт ли токен доступ к Ozon Доставке. xapi.ozon.ru выдаёт токены и приложениям кабинета
 *  продавца (Seller API) — тогда в правах нет ни одного delivery-api. null — токен не разобрать. */
export function tokenHasDeliveryAccess(accessToken: string): boolean | null {
  const part = accessToken.split('.')[1]
  if (!part) return null
  try {
    const p = JSON.parse(Buffer.from(part, 'base64url').toString()) as { scope?: unknown; permissions?: unknown }
    const scopes = Array.isArray(p.scope) ? p.scope : typeof p.scope === 'string' ? p.scope.split(' ') : []
    const perms = p.permissions && typeof p.permissions === 'object' ? Object.keys(p.permissions) : []
    if (!scopes.length && !perms.length) return null
    return scopes.some((s) => String(s).startsWith('delivery-api')) || perms.includes('delivery-api')
  } catch { return null }
}
