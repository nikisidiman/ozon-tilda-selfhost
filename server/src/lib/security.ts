import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { q, one } from '../db.js'

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>
const N = 16384, R = 8, P = 1, LEN = 32

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scrypt(pw, salt, LEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$')
  if (alg !== 'scrypt') return false
  const expected = Buffer.from(hash, 'base64')
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 })
  return got.length === expected.length && timingSafeEqual(got, expected)
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/** Публичный ключ магазина: sh_ + 10 символов base32 без похожих букв. */
export function newShopKey(): string {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789'
  const b = randomBytes(10)
  return 'sh_' + [...b].map((x) => abc[x % abc.length]).join('')
}

/** IP без последнего октета (IPv4) или без последних 80 бит (IPv6) — для логов. */
export function truncateIp(ip: string): string {
  if (!ip) return '-'
  if (ip.includes('.')) return ip.split('.').slice(0, 3).join('.') + '.0'
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + '::'
  return '-'
}

/** Домен из Origin/ввода пользователя: без схемы, порта, www, пути; нижний регистр. */
export function normalizeDomain(raw: string): string | null {
  let s = String(raw || '').trim().toLowerCase()
  if (!s) return null
  if (!/^[a-z]+:\/\//.test(s)) s = 'https://' + s
  try {
    const host = new URL(s).hostname.replace(/^www\./, '').replace(/\.$/, '')
    if (!/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(host) && !/^xn--/.test(host)) return null
    return host
  } catch {
    return null
  }
}

/** Скользящее окно в БД: +1 к счётчику, возвращает количество в окне. */
export async function rateHit(bucket: string, windowSec: number): Promise<number> {
  const end = new Date(Math.ceil(Date.now() / (windowSec * 1000)) * windowSec * 1000)
  const row = await one<{ hits: number }>(
    `insert into rate_hits (bucket, window_end, hits) values ($1, $2, 1)
     on conflict (bucket, window_end) do update set hits = rate_hits.hits + 1
     returning hits`, [bucket, end])
  return row?.hits ?? 0
}

export async function cleanupExpired(): Promise<void> {
  await q(`delete from rate_hits where window_end < now() - interval '1 day'`)
  await q(`delete from sessions where expires_at < now()`)
  await q(`delete from password_resets where expires_at < now() - interval '1 day'`)
  await q(`delete from login_failures where at < now() - interval '1 day'`)
  await q(`delete from quote_cache where fetched_at < now() - interval '7 days'`)
  await q(`delete from hook_log where at < now() - interval '30 days'`)
  await q(`delete from phone_checks where checked_at < now() - interval '30 days' or (not can_be_delivered and checked_at < now() - interval '1 hour')`)
}
