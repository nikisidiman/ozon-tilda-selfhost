import type { Context } from 'hono'

/** IP клиента. За Caddy — первый адрес X-Forwarded-For (Caddy ставит его сам). */
export function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for') || ''
  return xff.split(',')[0].trim() || c.req.header('x-real-ip') || ''
}
