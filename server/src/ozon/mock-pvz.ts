// Тестовый реестр для режима OZON_MODE=mock (нет ключей Ozon). Адреса условные,
// id не совпадают с настоящими пунктами Ozon — в боевом режиме эти записи не грузятся.
import { config } from '../config.js'
import { one, q } from '../db.js'

export const MOCK_PVZ = [
  { id: 9000000001, city: 'Москва', name: 'Ozon, ул. Тверская, 12', address: 'Москва, ул. Тверская, 12', hours: 'Ежедневно 10:00–21:00' },
  { id: 9000000002, city: 'Москва', name: 'Ozon, Ленинградский пр-т, 36', address: 'Москва, Ленинградский проспект, 36', hours: 'Ежедневно 09:00–21:00' },
  { id: 9000000003, city: 'Москва', name: 'Ozon, ул. Профсоюзная, 56', address: 'Москва, ул. Профсоюзная, 56', hours: 'Ежедневно 10:00–22:00' },
  { id: 9000000011, city: 'Санкт-Петербург', name: 'Ozon, Невский пр-т, 88', address: 'Санкт-Петербург, Невский проспект, 88', hours: 'Ежедневно 10:00–21:00' },
  { id: 9000000012, city: 'Санкт-Петербург', name: 'Ozon, ул. Савушкина, 7', address: 'Санкт-Петербург, ул. Савушкина, 7', hours: 'Ежедневно 09:00–21:00' },
  { id: 9000000021, city: 'Казань', name: 'Ozon, ул. Баумана, 44', address: 'Казань, ул. Баумана, 44', hours: 'Ежедневно 10:00–21:00' },
  { id: 9000000022, city: 'Казань', name: 'Ozon, пр-т Победы, 141', address: 'Казань, проспект Победы, 141', hours: 'Ежедневно 10:00–20:00' },
  { id: 9000000031, city: 'Екатеринбург', name: 'Ozon, ул. Малышева, 5', address: 'Екатеринбург, ул. Малышева, 5', hours: 'Ежедневно 10:00–21:00' },
  { id: 9000000041, city: 'Новосибирск', name: 'Ozon, Красный пр-т, 101', address: 'Новосибирск, Красный проспект, 101', hours: 'Ежедневно 10:00–21:00' },
  { id: 9000000051, city: 'Краснодар', name: 'Ozon, ул. Красная, 176', address: 'Краснодар, ул. Красная, 176', hours: 'Ежедневно 10:00–21:00' },
  { id: 9000000071, city: 'Тольятти', name: 'Ozon, ул. Юбилейная, 31', address: 'Тольятти, ул. Юбилейная, 31', hours: 'Ежедневно 10:00–21:00' },
  { id: 9000000061, city: 'Ростов-на-Дону', name: 'Ozon, ул. Большая Садовая, 46', address: 'Ростов-на-Дону, ул. Большая Садовая, 46', hours: 'Ежедневно 10:00–21:00' },
]

export async function seedMockPvz(): Promise<void> {
  if (config.ozon.mode !== 'mock') return
  const n = await one<{ n: string }>('select count(*) n from pvz')
  if (Number(n?.n) > 0) return
  for (const p of MOCK_PVZ) {
    await q('insert into pvz (id, city, name, address, working_hours) values ($1,$2,$3,$4,$5) on conflict do nothing',
      [p.id, p.city, p.name, p.address, p.hours])
  }
  console.log(`[pvz] режим mock: загружено ${MOCK_PVZ.length} тестовых пунктов`)
}
