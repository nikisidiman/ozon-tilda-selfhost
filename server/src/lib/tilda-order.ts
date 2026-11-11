// Заказ из вебхука Tilda. Чистые функции, без сети — покрыты тестами.
// Tilda шлёт заказ либо JSON, либо формой (application/x-www-form-urlencoded); корзина —
// в поле payment: JSON-строкой или ключами вида payment[products][0][name] («как массив»).
// Пункт выдачи виджет кладёт в название доставки и в своё поле: «Ozon 16703, адрес».
// Габариты посылки — в поле ozon_parcel: «300×150×100 мм, 1350 г» (виджет считает их по
// товарам корзины; пусто — у какого-то товара габариты не заполнены).
// maskPersonal — копия тела для журнала вебхуков без данных покупателя.

export interface ParcelDims { length_mm: number; width_mm: number; height_mm: number; weight_g: number | null }

export interface TildaOrder {
  orderId: string
  phone: string | null
  name: string
  pvzId: number | null
  goodsKop: number
  description: string
  parcel: ParcelDims | null
}

type Obj = Record<string, unknown>

/** Ключи формы «payment[products][0][name]» → вложенные объекты и массивы. */
export function nestForm(params: URLSearchParams): Obj {
  const root: Obj = {}
  for (const [key, value] of params) {
    const parts = key.replace(/\]/g, '').split('[')
    let node: Obj = root
    parts.forEach((p, i) => {
      if (i === parts.length - 1) { node[p] = value; return }
      if (typeof node[p] !== 'object' || node[p] === null) node[p] = /^\d+$/.test(parts[i + 1]) ? [] : {}
      node = node[p] as Obj
    })
  }
  return root
}

/** Тело вебхука: JSON или форма. payment в форме бывает JSON-строкой. */
export function parseTildaBody(text: string, contentType: string): Obj {
  let body: Obj
  if (/json/i.test(contentType) || /^\s*\{/.test(text)) {
    try { body = JSON.parse(text) as Obj } catch { body = {} }
  } else {
    body = nestForm(new URLSearchParams(text))
  }
  if (typeof body.payment === 'string') {
    try { body.payment = JSON.parse(body.payment) } catch { /* не JSON — оставляем строкой */ }
  }
  return body
}

export function isTildaTest(body: Obj): boolean {
  return body.test === 'test'
}

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '')

function field(body: Obj, exact: RegExp, loose: RegExp): string {
  const keys = Object.keys(body)
  const k = keys.find((x) => exact.test(x)) ?? keys.find((x) => loose.test(x))
  return k ? str(body[k]) : ''
}

const PVZ_RE = /\bOzon (\d{3,})\b/

/** Номер пункта выдачи Ozon из полей заказа; null — заказ не с доставкой Ozon. */
export function pvzOf(body: Obj): number | null {
  const pay = (typeof body.payment === 'object' && body.payment) ? body.payment as Obj : {}
  // Сначала известные места, потом любое поле на любой глубине: в каком поле Tilda отдаёт
  // пункт, зависит от режима доставки и настроек вебхука.
  const first = [body.ozon_pickup_point, body['tildadelivery-pickup-name'], pay.delivery, pay.delivery_address]
  for (const v of [...first, ...strings(body)]) {
    const m = PVZ_RE.exec(str(v))
    if (m) return Number(m[1])
  }
  return null
}

function strings(v: unknown, depth = 0): string[] {
  if (depth > 5 || v === null || typeof v !== 'object') return typeof v === 'string' ? [v] : []
  return Object.values(v as Obj).flatMap((x) => strings(x, depth + 1))
}

/** Структура тела без значений — для журнала, когда заказ не разобрали (данные покупателя не пишем). */
export function shapeOf(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : []
  if (v && typeof v === 'object') {
    if (depth > 4) return '{…}'
    return Object.fromEntries(Object.entries(v as Obj).slice(0, 60).map(([k, x]) => [k, shapeOf(x, depth + 1)]))
  }
  if (typeof v === 'string') return PVZ_RE.test(v) ? 'str:ozon' : `str${v.length}`
  return typeof v
}

// Поля с данными покупателя. Название товара (products[].name) и пункт Ozon — не они.
const PERSONAL_KEY = /name|имя|фио|fio|surname|фамил|отчеств|phone|телефон|^tel|mail|почт|address|адрес|street|улиц|house|flat|кварт|comment|коммент|cookie|passport|паспорт|^ip$/i
const KEEP_KEY = /^(formid|formname|tranid|orderid|ozon_.*)$/i
const EMAIL_RE = /[^\s@"]+@[^\s@"]+\.[^\s@"]+/g
const PHONE_RE = /(\+7|\b8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/g

/** Тело вебхука для журнала: данные покупателя → «***», остальное как есть. */
export function maskPersonal(v: unknown, key = '', inProducts = false, depth = 0): unknown {
  if (depth > 8) return '{…}'
  if (Array.isArray(v)) return v.map((x) => maskPersonal(x, key, inProducts || key === 'products', depth + 1))
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Obj).map(([k, x]) => [k, maskPersonal(x, k, inProducts, depth + 1)]))
  }
  if (typeof v !== 'string' || KEEP_KEY.test(key)) return v
  if (PVZ_RE.test(v)) return v   // название и адрес пункта Ozon — не адрес покупателя
  if (!inProducts && PERSONAL_KEY.test(key)) return v ? '***' : v
  return v.replace(EMAIL_RE, '***').replace(PHONE_RE, '***')
}

const PARCEL_RE =/(\d+)\s*[×xх*]\s*(\d+)\s*[×xх*]\s*(\d+)\s*мм(?:\D+(\d+)\s*г)?/i

/** «300×150×100 мм, 1350 г» → габариты; стороны по убыванию, вне разумных пределов — null. */
export function parseParcel(v: unknown): ParcelDims | null {
  const m = PARCEL_RE.exec(str(v))
  if (!m) return null
  const [l, w, h] = [m[1], m[2], m[3]].map(Number).sort((a, b) => b - a)
  if (h < 1 || l > 2000) return null
  const g = m[4] ? Number(m[4]) : null
  return { length_mm: l, width_mm: w, height_mm: h, weight_g: g && g > 0 && g <= 100_000 ? g : null }
}

function rubToKop(v: unknown): number | null {
  const s = str(v)
  const n = Number(s.replace(',', '.'))
  return s && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null
}

export function tildaOrder(body: Obj): TildaOrder | null {
  const pay = (typeof body.payment === 'object' && body.payment) ? body.payment as Obj : {}
  const orderId = str(pay.orderid) || str(body.tranid)
  if (!orderId) return null
  const products = Array.isArray(pay.products) ? pay.products as Obj[] : []

  let goodsKop = products.reduce((s, p) => s + (rubToKop(p.amount) ?? 0), 0)
  if (!goodsKop) goodsKop = rubToKop(pay.subtotal) ?? Math.max(0, (rubToKop(pay.amount) ?? 0) - (rubToKop(pay.delivery_price) ?? 0))

  const names = products.map((p) => {
    const n = str(p.name), q = Number(p.quantity)
    return n && q > 1 ? `${n} × ${q}` : n
  }).filter(Boolean)
  const text = names.join('; ') || 'Товары заказа'

  return {
    orderId: orderId.slice(0, 64),
    phone: field(body, /^(phone|телефон)$/i, /phone|телефон/i) || null,
    name: (field(body, /^(name|имя|фио)$/i, /^(fio|full_?name)$/i) || str(pay.delivery_fio)).slice(0, 200),
    pvzId: pvzOf(body),
    goodsKop,
    description: text.length > 240 ? `${text.slice(0, 237)}…` : text,
    parcel: parseParcel(body.ozon_parcel),
  }
}
