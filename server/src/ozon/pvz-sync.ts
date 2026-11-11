// Реестр пунктов выдачи из Ozon Delivery API:
//   /v1/delivery-point/list — все ID пунктов страницами (курсор);
//   /v1/delivery-point/info — адрес, координаты, график, активность, пачками до 100.
// Города в ответе нет, есть только full_address — город достаём из адреса (cityFromAddress).
// Раньше (06.10.2026) list отвечал пусто — если повторится, в логе будет «0 пунктов»,
// а реестр не затирается (пункты гасятся, только если пришла непустая выгрузка).

import { config } from '../config.js'
import { q } from '../db.js'
import { callOzon, ozonErrorOf, type OzonResponse } from './client.js'

// Важно: \b в JS-регулярках не работает с кириллицей, поэтому границы слов задаём явно.
const SETTLEMENT = /^(г\.?|город|пгт\.?|пос\.?|посёлок|поселок|с\.|село|д\.|деревня|рп\.?|ст-ца|станица)\s+(.+)$/i
const REGIONISH = /(^|[\s.])(обл\.?|область|край|респ\.?|республика|ао|автономный|округ|р-н|район|г\.о\.)(?=$|[\s.,])/i
const STREETISH = /(улица|^ул\.|\sул\.|проспект|пр-т|переулок|пер\.|шоссе|ш\.|бульвар|б-р|площадь|пл\.|набережная|наб\.|микрорайон|мкр|тракт|проезд|аллея|линия|квартал|территория|тер\.|\d)/i
/** Одно слово-прилагательное: «Краснодарский» (регион без слова «край»). */
const ADJECTIVE = /^[А-ЯЁа-яё-]+(ский|ская|цкий|цкая|ой|ая)$/

/**
 * Город из адреса Ozon. Форматы в реестре разные:
 * «г. Москва, ул. …», «Россия, Краснодарский Край, Краснодар, улица …»,
 * «Россия, Краснодарский, Краснодар, …», «Республика Татарстан, г Казань, …».
 */
export function cityFromAddress(full: string): string | null {
  const parts = full.split(',').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
  for (const p of parts) {
    const m = SETTLEMENT.exec(p)
    if (m) return m[2].trim()
  }
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (/^\d{6}$/.test(p) || /^Россия$/i.test(p) || REGIONISH.test(p)) continue
    if (STREETISH.test(p)) return null
    // «Краснодарский» перед «Краснодар» — регион; «Каменск-Уральский» перед улицей — город.
    const next = parts[i + 1]
    if (ADJECTIVE.test(p) && next && !STREETISH.test(next) && !REGIONISH.test(next)) continue
    return p
  }
  return null
}

type Period = { from_local?: string; to_local?: string }
export function hoursFromSchedule(schedule: { date?: string; periods?: Period[] }[] | undefined): string | null {
  const day = schedule?.find((d) => d.periods?.length)
  if (!day?.periods?.length) return null
  const fmt = (t?: string) => (t ?? '').slice(0, 5)
  return day.periods.map((p) => `${fmt(p.from_local)}–${fmt(p.to_local)}`).join(', ')
}

interface PointInfo {
  delivery_point_id: number; name: string; type: string; full_address: string
  coordinates?: { latitude?: number; longitude?: number }
  schedule?: { date?: string; periods?: Period[] }[]
  is_active: boolean; is_bulky?: boolean
}

let running = false

export async function syncPvz(): Promise<void> {
  if (config.ozon.mode !== 'live' || running) return
  running = true
  const started = Date.now()
  try {
    const ids: number[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5000; page++) {
      const r: OzonResponse<{ delivery_points?: { delivery_point_id: number }[]; next_cursor?: string | null }> = await callOzon(
        '/v1/delivery-point/list', { pagination: { ...(cursor ? { cursor } : {}), limit: 1000 } })
      if (!r.ok) { console.error('[pvz] list:', r.status, ozonErrorOf(r).message); return }
      for (const p of r.body?.delivery_points ?? []) ids.push(Number(p.delivery_point_id))
      cursor = r.body?.next_cursor ?? null
      if (!cursor || !(r.body?.delivery_points?.length)) break
    }
    console.log(`[pvz] list: ${ids.length} пунктов`)
    if (!ids.length) return

    const seen: number[] = []
    let skipped = 0
    for (let i = 0; i < ids.length; i += 100) {
      let batch = ids.slice(i, i + 100)
      let r = await callOzon<{ delivery_points?: PointInfo[] }>('/v1/delivery-point/info', { delivery_point_ids: batch })
      // Один исчезнувший пункт роняет всю пачку (404 «Не найдены пункты выдачи: 1,2,3»): выкидываем их и повторяем.
      if (r.status === 404) {
        const gone = new Set((ozonErrorOf(r).message.match(/\d+/g) ?? []).map(Number))
        batch = batch.filter((id) => !gone.has(id))
        if (batch.length) r = await callOzon<{ delivery_points?: PointInfo[] }>('/v1/delivery-point/info', { delivery_point_ids: batch })
      }
      if (!r.ok) { console.error('[pvz] info:', r.status, ozonErrorOf(r).message); continue }
      for (const p of r.body?.delivery_points ?? []) {
        const city = cityFromAddress(p.full_address ?? '')
        if (!city || !p.is_active) { skipped++; continue }
        seen.push(p.delivery_point_id)
        await q(`insert into pvz (id, city, name, address, working_hours, lat, lon, enabled, synced_at)
                 values ($1,$2,$3,$4,$5,$6,$7,true,now())
                 on conflict (id) do update set city=excluded.city, name=excluded.name, address=excluded.address,
                   working_hours=excluded.working_hours, lat=excluded.lat, lon=excluded.lon, enabled=true, synced_at=now()`,
        [p.delivery_point_id, city, p.name || p.full_address, p.full_address, hoursFromSchedule(p.schedule),
          p.coordinates?.latitude ?? null, p.coordinates?.longitude ?? null])
      }
    }
    // Гасим пропавшие из выгрузки, только если она полная (иначе сбой Ozon выключил бы весь реестр).
    if (seen.length > ids.length * 0.5) {
      await q(`update pvz set enabled = false where synced_at < now() - interval '1 hour' and enabled`)
    }
    console.log(`[pvz] синхронизация: ${seen.length} активных, пропущено ${skipped}, ${Math.round((Date.now() - started) / 1000)} с`)
  } catch (e) {
    console.error('[pvz] синхронизация упала:', (e as Error).message)
  } finally {
    running = false
  }
}

/** Каждую ночь в ~04:00 МСК. Первую загрузку делает ozon-tilda setup (cli/setup.ts), показывая ход. */
export function schedulePvzSync(): void {
  if (config.ozon.mode !== 'live') return
  // Тестовые пункты режима mock (id 9000000000–9000000999) в боевом режиме не нужны.
  q('delete from quote_cache where pvz_id between 9000000000 and 9000000999')
    .then(() => q('delete from pvz where id between 9000000000 and 9000000999'))
    .catch((e) => console.error('[pvz] старт:', e.message))
  setInterval(() => {
    const msk = new Date(Date.now() + 3 * 3600_000)
    if (msk.getUTCHours() === 4 && msk.getUTCMinutes() < 10) syncPvz()
  }, 10 * 60_000)
}
